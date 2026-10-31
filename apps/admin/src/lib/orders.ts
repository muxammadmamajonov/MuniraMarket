import { isOrderStatus, type Locale, type OrderStatus } from '@muniramarket/contracts';

/** Orders per list page. The API allows more; 20 keeps the table scannable. */
export const ORDERS_PAGE_SIZE = 20;

/** `?status=` of the list: a known status, anything else means "all". */
export function parseStatusFilter(value: string | null): OrderStatus | null {
  return isOrderStatus(value) ? value : null;
}

/** `?page=` of the list: a positive integer, anything else means the first page. */
export function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** Link to the orders list with a filter and page (defaults are left out of the URL). */
export function ordersHref(
  locale: Locale,
  { status, page }: { status: OrderStatus | null; page: number },
): string {
  const query = new URLSearchParams();
  if (status !== null) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  return `/${locale}${search === '' ? '' : `?${search}`}`;
}

/** Link to one order. The id is a UUID, but is encoded anyway. */
export function orderHref(locale: Locale, id: string): string {
  return `/${locale}/orders/${encodeURIComponent(id)}`;
}

/** Order ids are UUIDs; anything else cannot exist, so no request is made for it. */
export const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
