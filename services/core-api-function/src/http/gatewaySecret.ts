import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Gateway -> Function authentication. The Function has a public invocation URL, so EVERY request
 * (health checks included) must carry the shared secret the Cloudflare gateway Worker adds; the
 * gateway strips any copy a browser sends. Compared in constant time over SHA-256 digests (equal
 * lengths, so the comparison itself leaks neither the secret nor its length), before any body is
 * read or the database is touched.
 */

export const GATEWAY_SECRET_HEADER = 'x-mm-gateway-secret';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createGatewaySecretCheck(secret: string): (headers: Headers) => boolean {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('CORE_API_FUNCTION_SECRET must be at least 32 bytes');
  }
  const expected = digest(secret);
  return (headers) => {
    const provided = headers.get(GATEWAY_SECRET_HEADER);
    if (provided === null || provided === '') return false;
    return timingSafeEqual(digest(provided), expected);
  };
}
