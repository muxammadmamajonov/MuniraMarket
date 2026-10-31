import { ApiRequestError, readJson } from './errors';

/** Result of a write or read that never throws: callers branch on `ok`. */
export type Result<T> =
  { ok: true; status: number; data: T } | { ok: false; error: ApiRequestError };

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** `RequestInit` for a JSON write. `apiFetch` adds the CSRF header on unsafe methods. */
export function jsonInit(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Sends a request through the session-aware `apiFetch` and parses a JSON body (204 -> `undefined`).
 * Network failures and non-2xx answers become `{ ok: false, error }`; nothing here throws.
 */
export async function request<T = undefined>(
  apiFetch: ApiFetch,
  path: string,
  init?: RequestInit,
): Promise<Result<T>> {
  try {
    const response = await apiFetch(path, init);
    if (!response.ok) return { ok: false, error: await ApiRequestError.fromResponse(response) };
    if (response.status === 204) return { ok: true, status: 204, data: undefined as T };
    return { ok: true, status: response.status, data: await readJson<T>(response) };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause),
    };
  }
}
