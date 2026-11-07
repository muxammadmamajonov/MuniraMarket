import { createCoreApiClient } from '../../telegram/tgcloud/lib/coreApi/client.js';
import { CoreApiError } from '../../telegram/tgcloud/lib/coreApi/errors.js';
import { MIN_SECRET_BYTES } from '../../telegram/tgcloud/lib/coreApi/signer.js';

/**
 * What the gateway's Cloudflare Cron Trigger does on every tick (`scheduled()` in index.ts).
 *
 * The Cron Trigger stays on Cloudflare (no Neon Function Trigger), but on the Workers Free plan an
 * invocation has 10 ms of CPU, so it does no batch work itself. It only signs (ADR 0003, empty
 * actor) and forwards two POSTs through the in-process `scheduler` entrance:
 *
 * - every minute: `internal/scheduler/notifications/drain`. The Core API Function claims the
 *   notification outbox (ADR 0008), sends the Telegram messages and reports outcomes, all next to
 *   Postgres; the response carries counts only.
 * - every 15th minute (UTC, from `controller.scheduledTime`): `internal/maintenance/cleanup`
 *   (expired sessions, rate limits, nonces, OIDC states).
 *
 * Waiting for the Function is wall-clock time, not CPU. HMAC signing of a few hundred bytes is
 * microseconds.
 *
 * Retry safety: Cloudflare cron is best effort (late, skipped or overlapping ticks). The outbox
 * lease plus the `attempt` fencing token make overlapping drains deliver each message at least
 * once and never let a stale worker overwrite an outcome; a message whose outcome was not reported
 * is claimable again when its 60 s lease ends, so nothing is lost when a tick fails mid-way.
 * Cleanup is idempotent. Every failure is caught and logged (class/status/code only).
 */

/** Never resolved: requests are handed to `forward()` in-process, the host only fills the URL. */
export const SCHEDULER_BASE_URL = 'https://core-api.scheduler.invalid';
export const DEFAULT_SCHEDULER_KEY_ID = 'scheduler';
export const CLEANUP_EVERY_MINUTES = 15;
export const DRAIN_PATH = '/api/v1/internal/scheduler/notifications/drain';
export const CLEANUP_PATH = '/api/v1/internal/maintenance/cleanup';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface SchedulerEnv {
  /** The `scheduler` entry's secret; the Function's `SERVICE_AUTH_KEYS` holds the same pair. */
  SCHEDULER_SERVICE_SECRET?: string;
  SCHEDULER_SERVICE_KEY_ID?: string;
}

export type LogFn = (
  level: 'info' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type SigningKey =
  | { ok: true; keyId: string; secret: string }
  | { ok: false; reason: 'secret_missing' | 'key_id_invalid' | 'secret_too_short' };

/** Fails closed; the reason never contains the key or the secret. */
export function selectSigningKey(env: SchedulerEnv): SigningKey {
  const keyId = env.SCHEDULER_SERVICE_KEY_ID?.trim() || DEFAULT_SCHEDULER_KEY_ID;
  if (!KEY_ID.test(keyId)) return { ok: false, reason: 'key_id_invalid' };
  const secret = env.SCHEDULER_SERVICE_SECRET ?? '';
  if (secret.trim() === '') return { ok: false, reason: 'secret_missing' };
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) {
    return { ok: false, reason: 'secret_too_short' };
  }
  return { ok: true, keyId, secret };
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

/** Adapts the signing client's `fetch` to the in-process `forward()`. */
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

const SUMMARY_KEYS = [
  'claimed',
  'delivered',
  'blocked',
  'retried',
  'failed',
  'skipped',
  'report_failed',
] as const;

/** Counts only (no ids, chat ids or order numbers), whatever the response contained. */
export function summaryCounts(body: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof body !== 'object' || body === null) return counts;
  for (const key of SUMMARY_KEYS) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return counts;
}

export interface TickDeps {
  env: SchedulerEnv;
  /** `controller.scheduledTime` (epoch ms). */
  scheduledTime: number;
  /** `forward(request, ..., 'scheduler')`. */
  forward: (request: Request) => Promise<Response>;
  log: LogFn;
  now?: () => number;
}

export type StepResult = 'ok' | 'failed' | 'skipped' | 'not_due';

/** One Cron Trigger tick. Never rejects: every failure is logged and reported in the result. */
export async function runScheduledTick(
  deps: TickDeps,
): Promise<{ drain: StepResult; cleanup: StepResult }> {
  const { log } = deps;
  const key = selectSigningKey(deps.env);
  if (!key.ok) {
    log('error', 'scheduler: signing key unavailable, tick skipped', { reason: key.reason });
    return { drain: 'skipped', cleanup: 'skipped' };
  }

  let coreApi: ReturnType<typeof createCoreApiClient>;
  try {
    coreApi = createCoreApiClient({
      fetch: schedulerFetch(deps.forward),
      config: { baseUrl: SCHEDULER_BASE_URL, keyId: key.keyId, secret: key.secret },
      // `forward()` bounds every scheduler request itself.
      timeoutMs: 0,
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    log('error', 'scheduler: core api client unavailable, tick skipped', errorFields(error));
    return { drain: 'skipped', cleanup: 'skipped' };
  }

  let drain: StepResult;
  try {
    const summary = summaryCounts(await coreApi.request('POST', DRAIN_PATH));
    if ((summary['claimed'] ?? 0) > 0) log('info', 'scheduler: outbox drained', summary);
    drain = 'ok';
  } catch (error) {
    log('error', 'scheduler: outbox drain failed', errorFields(error));
    drain = 'failed';
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
