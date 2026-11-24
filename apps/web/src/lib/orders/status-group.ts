import { ORDER_STATUS_GROUPS, type OrderStatusGroup } from '@muniramarket/contracts';

/**
 * URL state of the orders page (`/orders?status=&page=`). Plain functions shared by the server
 * page (which reads the URL) and the client components (which build links), so they live outside
 * any `'use client'` module.
 */

/** `?status=` on `/orders`; anything unknown (or missing) is `all`. */
export function parseStatusGroup(value: string | string[] | undefined): OrderStatusGroup {
  const first = Array.isArray(value) ? value[0] : value;
  return (ORDER_STATUS_GROUPS as readonly string[]).includes(first ?? '')
    ? (first as OrderStatusGroup)
    : 'all';
}

export function ordersHref(locale: string, group: OrderStatusGroup, page = 1): string {
  const search = new URLSearchParams();
  if (group !== 'all') search.set('status', group);
  if (page > 1) search.set('page', String(page));
  const query = search.toString();
  return `/${locale}/orders${query === '' ? '' : `?${query}`}`;
}
