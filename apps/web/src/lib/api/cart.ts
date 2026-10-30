import type { AddCartItemRequest, Cart, UpdateCartItemRequest } from '@muniramarket/contracts';
import { ApiRequestError, readJson } from './errors';

/**
 * Cart calls. They take the session's `apiFetch` so cookies, CSRF and its single retry are
 * handled in one place. Every successful call returns the whole `Cart`, with all money computed
 * by the server; callers must display it as is and never recompute totals.
 */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function cartRequest(apiFetch: ApiFetch, path: string, init: RequestInit): Promise<Cart> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await ApiRequestError.fromResponse(response);
  return readJson<Cart>(response);
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function getCart(apiFetch: ApiFetch): Promise<Cart> {
  return cartRequest(apiFetch, '/cart', { method: 'GET' });
}

export function addCartItem(apiFetch: ApiFetch, request: AddCartItemRequest): Promise<Cart> {
  return cartRequest(apiFetch, '/cart/items', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

export function updateCartItem(
  apiFetch: ApiFetch,
  productId: string,
  request: UpdateCartItemRequest,
): Promise<Cart> {
  return cartRequest(apiFetch, `/cart/items/${encodeURIComponent(productId)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
}

export function removeCartItem(apiFetch: ApiFetch, productId: string): Promise<Cart> {
  return cartRequest(apiFetch, `/cart/items/${encodeURIComponent(productId)}`, {
    method: 'DELETE',
  });
}
