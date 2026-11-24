import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Random tokens and digests shared by sessions, CSRF, OIDC state and service auth (port of the
 * helpers in services/api/app/security/session.py and app/telegram/oidc.py).
 */

export const TOKEN_BYTES = 32;

/** `secrets.token_urlsafe(n)`: unpadded URL-safe base64 of `n` random bytes. */
export function tokenUrlsafe(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `hmac.compare_digest` over UTF-8 bytes: constant time for equal lengths, false otherwise. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still spend a comparison so the early exit does not depend on the content.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
