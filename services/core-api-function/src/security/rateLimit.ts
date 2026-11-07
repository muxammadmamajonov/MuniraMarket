import type { Database } from '../db.ts';
import { ApiError, StoreUnavailableError, storeUnavailable } from '../errors.ts';
import type { RateLimitRule } from '../http/auth.ts';
import { deps, type Clock, type Ctx } from '../http/context.ts';
import { currentUser } from './sessionDeps.ts';

/**
 * Fixed-window rate limiting (port of services/api/app/security/rate_limit.py and the
 * `rate_limit` dependency in app/api/auth_deps.py, ADR 0007/0013).
 *
 * One counter per `<scope>:<subject>:<window_start>` in `rate_limit_counters`. A hit is one atomic
 * `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits` in its own transaction:
 * concurrent requests serialise on the row lock, no hit is lost, and a route that later rolls
 * back never undoes the hit. Store failures fail closed (503).
 */

const SCOPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window ends (>= 1). */
  retryAfterSeconds: number;
}

/** `(window_start, retry_after)` for the fixed window containing `now`. */
export function windowFor(now: number, windowSeconds: number): [number, number] {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const retryAfter = Math.max(1, Math.ceil(windowStart + windowSeconds - now));
  return [windowStart, retryAfter];
}

export function rateLimitKey(scope: string, subject: string, windowStart: number): string {
  return `${scope}:${subject}:${windowStart}`;
}

export async function hitRateLimit(
  db: Database,
  clock: Clock,
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  const now = clock();
  const [windowStart, retryAfter] = windowFor(now, rule.windowSeconds);
  const bucket = rateLimitKey(rule.scope, subject, windowStart);
  // The row outlives its window by one window, which is plenty for the cleanup job.
  const expiresAt = windowStart + 2 * rule.windowSeconds;
  const hits = await db.storeTx(async (client) => {
    const { rows } = await client.query<{ hits: number }>(
      `INSERT INTO rate_limit_counters (bucket, hits, expires_at)
       VALUES ($1, 1, to_timestamp($2::float8))
       ON CONFLICT (bucket) DO UPDATE SET hits = rate_limit_counters.hits + 1
       RETURNING hits`,
      [bucket, expiresAt],
    );
    return rows[0]?.hits ?? Number.POSITIVE_INFINITY;
  });
  return { allowed: hits <= rule.limit, retryAfterSeconds: retryAfter };
}

/**
 * Count one request against `rule` for the client IP (`'ip'`, the gateway-written address) or the
 * signed-in user (`'user'`, which resolves the session first, exactly like FastAPI's `by_user`).
 * 429 `rate_limited` with `Retry-After` and `Cache-Control: no-store` once exceeded.
 */
export async function rateLimit(c: Ctx, rule: RateLimitRule, key: 'ip' | 'user'): Promise<void> {
  if (!SCOPE_RE.test(rule.scope) || rule.limit <= 0 || rule.windowSeconds <= 0) {
    throw new Error('rate_limit needs a lower-case scope and positive limit/window');
  }
  const subject = key === 'ip' ? c.get('clientIp') : (await currentUser(c)).id;
  const { db, clock, logger } = deps(c);
  let decision: RateLimitDecision;
  try {
    decision = await hitRateLimit(db, clock, rule, subject);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    logger.error('Rate limiter unavailable; failing closed', { scope: rule.scope });
    throw storeUnavailable();
  }
  if (!decision.allowed) {
    logger.info('Rate limit exceeded', { scope: rule.scope });
    throw new ApiError(429, 'rate_limited', 'Too many requests', {
      // Never cacheable, even on otherwise publicly cached catalog routes.
      headers: { 'retry-after': String(decision.retryAfterSeconds), 'cache-control': 'no-store' },
    });
  }
}
