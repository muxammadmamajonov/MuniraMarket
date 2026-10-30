import 'server-only';
import { isIP } from 'node:net';

/**
 * The real client IP from the edge-set header named by `CLIENT_IP_HEADER`, or `null`.
 *
 * Core API trusts this web server as its only proxy hop and rate-limits by the `x-forwarded-for`
 * we send, so the value must come only from a header the trusted edge overwrites and must parse
 * as a single IP address. A browser-sent `x-forwarded-for` is never used.
 */
export function clientIpFrom(
  headers: Pick<Headers, 'get'>,
  headerName: string | null,
): string | null {
  if (headerName === null) return null;
  const value = headers.get(headerName)?.trim() ?? '';
  return isIP(value) !== 0 ? value : null;
}
