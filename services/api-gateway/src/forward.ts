import {
  type Entrance,
  errorResponse,
  functionOrigin,
  isAllowed,
  singleIp,
  upstreamHeaders,
  upstreamUrl,
} from './routing';

/**
 * Forwarding to the Core API Neon Function. No Workers-only APIs, so it runs under plain Vitest
 * (test/forward.test.ts: normal, timeout, bad secret, spoofed headers).
 */

// The Function answers well within this; a scale-from-zero start is included.
export const UPSTREAM_TIMEOUT_MS = 20_000;
// The scheduler entrance waits for a whole outbox drain (bounded in the Function).
export const SCHEDULER_TIMEOUT_MS = 60_000;

export function log(
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, msg: message, service: 'api-gateway', ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export interface ForwardDeps {
  env: { CORE_API_FUNCTION_ORIGIN?: string; CORE_API_FUNCTION_SECRET?: string };
  fetch: (request: Request) => Promise<Response>;
  /** Overrides for tests. */
  timeouts?: { upstreamMs: number; schedulerMs: number };
}

export async function forward(
  request: Request,
  deps: ForwardDeps,
  entrance: Entrance,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAllowed(entrance, request.method, url.pathname)) {
    return errorResponse(404, 'not_found', 'Not Found');
  }

  const origin = functionOrigin(deps.env.CORE_API_FUNCTION_ORIGIN);
  const secret = deps.env.CORE_API_FUNCTION_SECRET ?? '';
  if (origin === null || new TextEncoder().encode(secret).length < 32) {
    // Misconfiguration: fail closed without saying which value is wrong.
    log('error', 'core api function is not configured', { entrance });
    return errorResponse(503, 'service_unavailable', 'Service unavailable');
  }

  const clientIp =
    entrance === 'public'
      ? singleIp(request.headers.get('cf-connecting-ip'))
      : entrance === 'scheduler'
        ? null
        : singleIp(request.headers.get('x-forwarded-for'));
  const headers = upstreamHeaders(request.headers, {
    entrance,
    clientIp,
    fallbackRequestId: request.headers.get('cf-ray') ?? crypto.randomUUID(),
    gatewaySecret: secret,
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const timeoutMs =
    entrance === 'scheduler'
      ? (deps.timeouts?.schedulerMs ?? SCHEDULER_TIMEOUT_MS)
      : (deps.timeouts?.upstreamMs ?? UPSTREAM_TIMEOUT_MS);
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    // Streamed as-is: the service signature covers the exact body bytes (ADR 0003).
    body: hasBody ? request.body : null,
    // Never follow a redirect with the secret attached.
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Node (tests) needs `duplex` for a streamed body; the Workers runtime ignores it.
  if (hasBody) init.duplex = 'half';
  const upstream = new Request(upstreamUrl(origin, url), init);

  try {
    const response = await deps.fetch(upstream);
    if (response.status >= 300 && response.status < 400) {
      // The Function never redirects across origins; do not hand a redirect to a browser.
      await response.body?.cancel();
      log('error', 'upstream redirect refused', { entrance, status: response.status });
      return errorResponse(502, 'service_unavailable', 'The service is unavailable');
    }
    if (response.status === 401) {
      // Only a wrong or missing gateway secret produces a bare 401 from the Function's edge
      // middleware; log it (no values) so a rotation mistake is visible.
      log('error', 'upstream rejected the request', { entrance, status: 401 });
    }
    return response;
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    log('error', 'upstream request failed', { entrance, timedOut });
    return timedOut
      ? errorResponse(504, 'service_unavailable', 'The service took too long to respond')
      : errorResponse(502, 'service_unavailable', 'The service is unavailable');
  }
}
