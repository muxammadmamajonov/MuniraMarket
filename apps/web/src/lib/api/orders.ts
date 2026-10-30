import {
  IDEMPOTENT_REPLAYED_HEADER,
  type CheckoutQuote,
  type CreateOrderRequest,
  type DistrictCode,
  type OrderDetail,
  type OrderPage,
} from '@muniramarket/contracts';
import type { ApiFetch } from './cart';
import { ApiRequestError, readJson } from './errors';
import { JSON_HEADERS, requestJson } from './request';

/**
 * Checkout and order calls. Like `cart.ts` they take the session's `apiFetch` (cookies, CSRF and
 * its single retry live there). All money in the replies is computed by the server.
 */

/** `POST /checkout/quote`: re-checks the cart and prices delivery for `district`. */
export function quoteCheckout(apiFetch: ApiFetch, district: DistrictCode): Promise<CheckoutQuote> {
  return requestJson<CheckoutQuote>(apiFetch, '/checkout/quote', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ district }),
  });
}

export interface PlacedOrder {
  order: OrderDetail;
  /** True when the API recognised the `Idempotency-Key` and returned the existing order. */
  replayed: boolean;
}

/**
 * `POST /orders`. `idempotencyKey` must be 16-128 characters of `[A-Za-z0-9_-]` and must stay the
 * same for a retry of the same request and change whenever the body changes (see
 * `lib/checkout/idempotency.ts`).
 */
export async function createOrder(
  apiFetch: ApiFetch,
  request: CreateOrderRequest,
  idempotencyKey: string,
): Promise<PlacedOrder> {
  const response = await apiFetch('/orders', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await ApiRequestError.fromResponse(response);
  return {
    order: await readJson<OrderDetail>(response),
    replayed: response.headers.get(IDEMPOTENT_REPLAYED_HEADER)?.toLowerCase() === 'true',
  };
}

export interface ListOrdersParams {
  page?: number;
  pageSize?: number;
}

/** `GET /orders`: the signed-in customer's orders, newest first. */
export function listOrders(apiFetch: ApiFetch, params: ListOrdersParams = {}): Promise<OrderPage> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('page_size', String(params.pageSize));
  const query = search.toString();
  return requestJson<OrderPage>(apiFetch, `/orders${query === '' ? '' : `?${query}`}`, {
    method: 'GET',
  });
}

/** `GET /orders/{id}`. `order_not_found` (404) also covers other customers' orders. */
export function getOrder(apiFetch: ApiFetch, id: string): Promise<OrderDetail> {
  return requestJson<OrderDetail>(apiFetch, `/orders/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
}

/** `POST /orders/{id}/cancel`. `order_not_cancellable` (409) carries `currentStatus`. */
export function cancelOrder(apiFetch: ApiFetch, id: string, reason: string): Promise<OrderDetail> {
  return requestJson<OrderDetail>(apiFetch, `/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ reason }),
  });
}
