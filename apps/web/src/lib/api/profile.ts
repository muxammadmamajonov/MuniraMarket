import type {
  SavedAddress,
  SavedAddressList,
  SavedAddressRequest,
  UpdateProfileRequest,
  UserPublic,
} from '@muniramarket/contracts';
import type { ApiFetch } from './cart';
import { ApiRequestError } from './errors';
import { JSON_HEADERS, requestJson } from './request';

/**
 * The signed-in customer's own profile and saved addresses. Like `cart.ts` these take the
 * session's `apiFetch` (cookies, CSRF and its single retry live there).
 */

/** Saved addresses per account; the Core API refuses the 11th with `address_limit_reached`. */
export const MAX_SAVED_ADDRESSES = 10;

/** `PATCH /me`: name, birthday and/or phone. Returns the updated user. */
export async function updateProfile(
  apiFetch: ApiFetch,
  changes: UpdateProfileRequest,
): Promise<UserPublic> {
  const body = await requestJson<{ user: UserPublic }>(apiFetch, '/me', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(changes),
  });
  return body.user;
}

/** `GET /me/addresses`: the default first, then the most recently changed. */
export async function listSavedAddresses(apiFetch: ApiFetch): Promise<SavedAddress[]> {
  const body = await requestJson<SavedAddressList>(apiFetch, '/me/addresses', { method: 'GET' });
  return Array.isArray(body.items) ? body.items : [];
}

/** `POST /me/addresses`. */
export function createSavedAddress(
  apiFetch: ApiFetch,
  request: SavedAddressRequest,
): Promise<SavedAddress> {
  return requestJson<SavedAddress>(apiFetch, '/me/addresses', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** `PUT /me/addresses/{id}` (full replace). */
export function updateSavedAddress(
  apiFetch: ApiFetch,
  id: string,
  request: SavedAddressRequest,
): Promise<SavedAddress> {
  return requestJson<SavedAddress>(apiFetch, `/me/addresses/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

/** `DELETE /me/addresses/{id}` (204). */
export async function deleteSavedAddress(apiFetch: ApiFetch, id: string): Promise<void> {
  const response = await apiFetch(`/me/addresses/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await ApiRequestError.fromResponse(response);
}
