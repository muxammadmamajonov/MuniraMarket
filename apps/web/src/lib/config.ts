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
