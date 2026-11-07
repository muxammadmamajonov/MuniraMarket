import { createCoreApiClient } from '../../telegram/tgcloud/lib/coreApi/client.js';
import { CoreApiError } from '../../telegram/tgcloud/lib/coreApi/errors.js';
import { MIN_SECRET_BYTES } from '../../telegram/tgcloud/lib/coreApi/signer.js';
import { drainOrderNotifications } from '../../telegram/tgcloud/lib/notifications/outbox.js';
import { createTelegramBotTransport } from '../../telegram/tgcloud/lib/notifications/transport.js';
import { type FetchFn, createBotApi } from './botApi';

/**
 * What the gateway's Cloudflare Cron Trigger does on every tick (`scheduled()` in index.ts).
 *
 * Telegram Serverless has no scheduler (https://core.telegram.org/bots/serverless documents only
 * update handlers, Mini App endpoints, `lib/` and `schema.js`), so the order-notification outbox
 * (ADR 0008) is drained from here instead, with the SAME dependency-free modules the bot ships
 * (`services/telegram/tgcloud/lib/`): signer, Core API client, drain and Bot API transport.
 *
 * - Every minute: `drainOrderNotifications` (customer status messages + staff group alerts).
 * - Every 15th minute (UTC, from `controller.scheduledTime`): `POST internal/maintenance/cleanup`.
 *
 * Requests go to the container through `forward(..., 'scheduler')` in-process: no network hop,
 * never the public hostname. They are signed per ADR 0003 with an EMPTY actor using the
 * `SERVICE_AUTH_KEYS` entry named by `SCHEDULER_SERVICE_KEY_ID`.
 *
 * Trade-offs, accepted deliberately:
 * - A per-minute cron keeps at least one container instance awake around the clock (it never
 *   reaches `CONTAINER_SLEEP_AFTER_MINUTES` of idleness). That is the cost of sub-minute-ish
 *   notification latency without any traffic-driven drain.
 * - Cloudflare Cron Triggers are best effort: a tick can be late, skipped, or (rarely) overlap
 *   the previous one. That is safe: the outbox lease plus the `attempt` fencing token make
 *   concurrent drains deliver each message at least once and never let a stale worker overwrite
 *   an outcome; a skipped tick only delays delivery to the next one. Cleanup is idempotent.
 * - Every failure is caught and logged (no PII, no token, no secret, no response body), so one
 *   bad tick never affects the next.
 */

/** Never resolved: requests are handed to `forward()` in-process, the host only fills the URL. */
export const SCHEDULER_BASE_URL = 'https://core-api.scheduler.invalid';
export const DEFAULT_SCHEDULER_KEY_ID = 'scheduler';
export const CLEANUP_EVERY_MINUTES = 15;
/** Messages per claim and claims per tick: up to 100 deliveries a minute. */
export const DRAIN_LIMIT = 20;
export const DRAIN_MAX_BATCHES = 5;
const CLEANUP_PATH = '/api/v1/internal/maintenance/cleanup';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface SchedulerEnv {
  SERVICE_AUTH_KEYS?: string;
  SCHEDULER_SERVICE_KEY_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

export type LogFn = (
  level: 'info' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type SigningKey =
  | { ok: true; keyId: string; secret: string }
  | {
      ok: false;
      reason: 'keys_missing' | 'key_id_invalid' | 'key_not_found' | 'secret_too_short';
    };

/**
 * Picks the scheduler's signing key from `SERVICE_AUTH_KEYS` (`key_id:secret[,key_id:secret]`,
 * parsed like the Core API does). Fails closed; the reason never contains a key or a secret.
 */
export function selectSigningKey(
  serviceAuthKeys: string | undefined,
  configuredKeyId: string | undefined,
): SigningKey {
  const keyId = configuredKeyId?.trim() || DEFAULT_SCHEDULER_KEY_ID;
  if (!KEY_ID.test(keyId)) return { ok: false, reason: 'key_id_invalid' };
  const raw = serviceAuthKeys ?? '';
  if (raw.trim() === '') return { ok: false, reason: 'keys_missing' };
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== keyId) continue;
    const secret = trimmed.slice(separator + 1);
    if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) {
      return { ok: false, reason: 'secret_too_short' };
    }
    return { ok: true, keyId, secret };
  }
  return { ok: false, reason: 'key_not_found' };
}

/** Whether this tick also runs the cleanup (minutes 0, 15, 30, 45 UTC). */
export function isCleanupTick(scheduledTime: number): boolean {
  if (!Number.isFinite(scheduledTime)) return false;
  return new Date(scheduledTime).getUTCMinutes() % CLEANUP_EVERY_MINUTES === 0;
}

type CoreFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
};

/**
 * Adapts the Core API client's `fetch` to the in-process `forward()`: the request never leaves
 * the Worker. The client's own timeout is disabled (`timeoutMs: 0`); `forward()` bounds every
 * upstream request itself, and a cold container start must not be cut short.
 */
export function schedulerFetch(forward: (request: Request) => Promise<Response>) {
  return async (url: string, init: CoreFetchInit = {}): Promise<Response> => {
    const requestInit: RequestInit = { method: init.method ?? 'GET' };
    if (init.headers !== undefined) requestInit.headers = init.headers;
    if (init.body !== undefined) requestInit.body = init.body;
    return forward(new Request(url, requestInit));
  };
}

/** Error fields that are safe to log: class, HTTP status and stable code. Never messages. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof CoreApiError) {
    return { error: 'CoreApiError', status: error.status, code: error.code };
  }
  if (error instanceof Error) return { error: error.name };
  return { error: 'non-error thrown' };
}

export interface TickDeps {
  env: SchedulerEnv;
  /** `controller.scheduledTime` (epoch ms). */
  scheduledTime: number;
  /** `forward(request, env, exports, 'scheduler')`. */
  forward: (request: Request) => Promise<Response>;
  /** Outbound fetch, used only for the Bot API. */
  fetch: FetchFn;
  log: LogFn;
  now?: () => number;
}

export type StepResult = 'ok' | 'failed' | 'skipped' | 'not_due';

/**
 * One Cron Trigger tick. Never rejects: every failure is logged and reported in the result.
 */
export async function runScheduledTick(
  deps: TickDeps,
): Promise<{ drain: StepResult; cleanup: StepResult }> {
  const { env, log } = deps;
  const key = selectSigningKey(env.SERVICE_AUTH_KEYS, env.SCHEDULER_SERVICE_KEY_ID);
  if (!key.ok) {
    log('error', 'scheduler: signing key unavailable, tick skipped', { reason: key.reason });
    return { drain: 'skipped', cleanup: 'skipped' };
  }

  let coreApi: ReturnType<typeof createCoreApiClient>;
  try {
    coreApi = createCoreApiClient({
      fetch: schedulerFetch(deps.forward),
      config: { baseUrl: SCHEDULER_BASE_URL, keyId: key.keyId, secret: key.secret },
      timeoutMs: 0,
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    log('error', 'scheduler: core api client unavailable, tick skipped', errorFields(error));
    return { drain: 'skipped', cleanup: 'skipped' };
  }

  let drain: StepResult;
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  if (token.trim() === '') {
    log('error', 'scheduler: TELEGRAM_BOT_TOKEN is not configured, drain skipped');
    drain = 'skipped';
  } else {
    try {
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTelegramBotTransport({ api: createBotApi(token, deps.fetch) }),
        limit: DRAIN_LIMIT,
        maxBatches: DRAIN_MAX_BATCHES,
        ...(deps.now ? { now: deps.now } : {}),
      });
      // Counts only: no ids, chat ids or order numbers.
      if (summary.claimed > 0) log('info', 'scheduler: outbox drained', { ...summary });
      drain = 'ok';
    } catch (error) {
      log('error', 'scheduler: outbox drain failed', errorFields(error));
      drain = 'failed';
    }
  }

  let cleanup: StepResult = 'not_due';
  if (isCleanupTick(deps.scheduledTime)) {
    try {
      await coreApi.request('POST', CLEANUP_PATH);
      log('info', 'scheduler: expired security state cleaned up');
      cleanup = 'ok';
    } catch (error) {
      log('error', 'scheduler: cleanup failed', errorFields(error));
      cleanup = 'failed';
    }
  }

  return { drain, cleanup };
}
