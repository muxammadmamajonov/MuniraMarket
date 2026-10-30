import 'server-only';
import { API_V1_PREFIX } from '@muniramarket/contracts';

const DEFAULT_API_INTERNAL_URL = 'http://localhost:8000';

/**
 * Base URL of the Core API as seen from the web server (no trailing slash).
 *
 * Read at runtime from `API_INTERNAL_URL`, which is server-only: it is never shipped to the
 * browser, because browsers reach the API through the same-origin proxy at `/api/v1/*`.
 */
export function getApiInternalUrl(): string {
  const raw = process.env['API_INTERNAL_URL'];
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_API_INTERNAL_URL : raw.trim();
  return value.replace(/\/+$/, '');
}

/** Absolute internal URL of a v1 API path, e.g. `internalApiUrl('/health')`. Server-only. */
export function internalApiUrl(path: string): string {
  return `${getApiInternalUrl()}${API_V1_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

/** HTTP header names are tokens; anything else in `CLIENT_IP_HEADER` is a misconfiguration. */
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * Name of the request header carrying the real client IP, set by the trusted edge in front of the
 * web server (for example `x-real-ip`), or `null` when not configured.
 *
 * The edge MUST overwrite this header on every request; a client-sent value must never pass
 * through. When unset, the proxy forwards no client IP at all and Core API rate-limits by the web
 * server's address (shared bucket: stricter, but impossible to spoof).
 */
export function getClientIpHeader(): string | null {
  const raw = process.env['CLIENT_IP_HEADER']?.trim().toLowerCase();
  return raw !== undefined && HEADER_NAME.test(raw) ? raw : null;
}
