import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
  type Entrance,
  errorResponse,
  instanceName,
  isAllowed,
  singleIp,
  upstreamHeaders,
} from './routing';

/**
 * Core API gateway: the only way into the FastAPI container (README.md).
 *
 * - `default.fetch`: the public hostname. Health checks and the Telegram Serverless routes only.
 * - `StorefrontApi` / `AdminApi`: named entrypoints, reachable only through the web and admin
 *   Workers' service bindings (they have no route of their own).
 * - `CoreApiContainer`: the Durable Object that starts the container image and forwards to it.
 */

const CONTAINER_PORT = 8000;
const HEALTH_PATH = '/api/v1/health';
// The Core API answers well within this; a cold start needs the readiness loop below first.
const UPSTREAM_TIMEOUT_MS = 20_000;

/** Values copied into the container's environment when it starts (secrets included). */
const CONTAINER_ENV_KEYS = [
  // secrets
  'DATABASE_URL',
  'REDIS_URL',
  'SERVICE_AUTH_KEYS',
  'TELEGRAM_BOT_TOKEN',
  // plain configuration
  'APP_ENV',
  'APP_RELEASE',
  'LOG_LEVEL',
  'TELEGRAM_BOT_ID',
  'TELEGRAM_ENVIRONMENT',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_LOGIN_WIDGET_ENABLED',
  'CSRF_TRUSTED_ORIGINS',
  'FORWARDED_ALLOW_IPS',
  'DB_POOL_SIZE',
  'DB_MAX_OVERFLOW',
] as const satisfies readonly (keyof Env)[];

function containerEnv(env: Env): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of CONTAINER_ENV_KEYS) {
    const value: unknown = env[key];
    if (typeof value === 'string' && value !== '') values[key] = value;
  }
  return values;
}

function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, msg: message, service: 'api-gateway', ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export class CoreApiContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.inactivityMs()));
    }
  }

  private inactivityMs(): number {
    const minutes = Number(this.env.CONTAINER_SLEEP_AFTER_MINUTES);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return errorResponse(503, 'service_unavailable', 'Service unavailable');

    // Concurrent requests share one start and readiness check; a failure can be retried.
    this.starting ??= this.startAndWaitForPort(container).finally(() => {
      this.starting = undefined;
    });
    try {
      await this.starting;
    } catch (error) {
      log('error', 'container did not become ready', {
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(503, 'service_unavailable', 'Service unavailable');
    }

    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    return container.getTcpPort(CONTAINER_PORT).fetch(new Request(url, request));
  }

  private async startAndWaitForPort(container: Container): Promise<void> {
    const image = container.images['api'];
    if (image === undefined) throw new Error('Container image "api" is not configured');
    if (!container.running) {
      container.start({
        image,
        // Needs egress to Neon (PostgreSQL over TLS) and the managed Redis.
        enableInternet: true,
        env: containerEnv(this.env),
      });
    }
    await container.setInactivityTimeout(this.inactivityMs());

    const port = container.getTcpPort(CONTAINER_PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await port.fetch(`http://container${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`health returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(200);
    }
    throw new Error('Core API container did not become ready', { cause: lastError });
  }
}

async function forward(
  request: Request,
  env: Env,
  exportsNs: Cloudflare.Exports,
  entrance: Entrance,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAllowed(entrance, request.method, url.pathname)) {
    return errorResponse(404, 'not_found', 'Not Found');
  }

  const clientIp =
    entrance === 'public'
      ? singleIp(request.headers.get('cf-connecting-ip'))
      : singleIp(request.headers.get('x-forwarded-for'));
  const headers = upstreamHeaders(request.headers, {
    entrance,
    clientIp,
    fallbackRequestId: request.headers.get('cf-ray') ?? crypto.randomUUID(),
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const upstream = new Request(url, {
    method,
    headers,
    // Streamed as-is: the service signature covers the exact body bytes (ADR 0003).
    body: hasBody ? request.body : null,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const count = Number(env.CONTAINER_INSTANCES);
  const stub = exportsNs.CoreApiContainer.getByName(instanceName(count));
  try {
    return await stub.fetch(upstream);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    log('error', 'upstream request failed', { entrance, timedOut });
    return timedOut
      ? errorResponse(504, 'service_unavailable', 'The service took too long to respond')
      : errorResponse(502, 'service_unavailable', 'The service is unavailable');
  }
}

/** Reachable only through the web Worker's service binding (`CORE_API`). */
export class StorefrontApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return forward(request, this.env, this.ctx.exports, 'storefront');
  }
}

/** Reachable only through the admin Worker's service binding (`CORE_API`). */
export class AdminApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return forward(request, this.env, this.ctx.exports, 'admin');
  }
}

export default {
  fetch(request, env, ctx) {
    return forward(request, env, ctx.exports, 'public');
  },
} satisfies ExportedHandler<Env>;
