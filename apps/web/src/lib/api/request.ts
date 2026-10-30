import type { ApiFetch } from './cart';
import { ApiRequestError, readJson } from './errors';

export const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Sends a request through the session's `apiFetch` and returns the parsed body of a 2xx reply. */
export async function requestJson<T>(
  apiFetch: ApiFetch,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await ApiRequestError.fromResponse(response);
  return readJson<T>(response);
}
