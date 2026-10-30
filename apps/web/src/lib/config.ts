import { API_V1_PREFIX } from '@muniramarket/contracts';

const DEFAULT_API_BASE_URL = 'http://localhost:8000';

/** Public base URL of the Core API (no trailing slash). Contains no secrets. */
export function getApiBaseUrl(): string {
  const raw = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Absolute URL of a v1 API path, e.g. `apiUrl('/health')` -> `<base>/api/v1/health`. */
export function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${API_V1_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}
