import { normalizeOrigin, type AppEnv } from '../config.ts';
import { constantTimeEqual } from './tokens.ts';

/**
 * CSRF defences for cookie-authenticated browser requests (port of
 * services/api/app/security/csrf.py, ADR 0007):
 * 1. Origin check: `Origin` (or, if absent, the origin of `Referer`) must be trusted. With
 *    neither header the request is rejected in staging/production, allowed in development/test.
 * 2. Synchronizer token: `X-CSRF-Token` must equal the session's token (constant time).
 */

export const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-csrf-token';

/** `reason` is a short label for logs; clients only ever see `csrf_failed`. */
export class CsrfError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'CsrfError';
    this.reason = reason;
  }
}

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function checkOrigin(
  headers: { origin: string | undefined; referer: string | undefined },
  options: { trustedOrigins: readonly string[]; appEnv: AppEnv },
): void {
  let origin = headers.origin;
  if (origin === undefined) {
    if (headers.referer === undefined) {
      if (options.appEnv === 'development' || options.appEnv === 'test') return;
      throw new CsrfError('origin_missing');
    }
    origin = headers.referer;
  }
  const normalized = normalizeOrigin(origin); // "null" and garbage normalise to null
  if (normalized === null || !options.trustedOrigins.includes(normalized)) {
    throw new CsrfError('origin_untrusted');
  }
}

export function checkToken(expected: string, received: string | undefined): void {
  if (received === undefined || received === '') throw new CsrfError('token_missing');
  if (!constantTimeEqual(expected, received)) throw new CsrfError('token_mismatch');
}
