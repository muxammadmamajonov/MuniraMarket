'use client';

import { ORDER_STATUSES, type OrderPage, type OrderStatus } from '@muniramarket/contracts';
import { EmptyState, ErrorState, Skeleton, cx, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { readErrorMessage } from '@/lib/api/error-messages';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import {
  ORDERS_PAGE_SIZE,
  orderHref,
  ordersHref,
  parsePage,
  parseStatusFilter,
} from '@/lib/orders';
import { useSession } from '@/lib/session';
import { StatusBadge } from './status-badge';

type Loaded =
  | { key: string; page: OrderPage; error: null }
  | { key: string; page: null; error: ApiRequestError };

const CHIP =
  'inline-flex min-h-11 items-center rounded-xl border px-3 text-sm font-medium ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function StatusFilter({ active }: { active: OrderStatus | null }) {
  const { dict, locale } = useI18n();
  const options: Array<OrderStatus | null> = [null, ...ORDER_STATUSES];
  return (
    <nav aria-label={dict.orders.filterLabel}>
      <ul className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = option === active;
          return (
            <li key={option ?? 'all'}>
              <Link
                href={ordersHref(locale, { status: option, page: 1 })}
                aria-current={selected ? 'true' : undefined}
                className={cx(
                  CHIP,
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-surface text-foreground hover:bg-surface-muted',
                )}
              >
                {option === null ? dict.orders.filterAll : dict.status[option]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Pagination({
  status,
  page,
  totalPages,
}: {
  status: OrderStatus | null;
  page: number;
  totalPages: number;
}) {
  const { dict, locale } = useI18n();
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;
  const link =
    'inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-medium hover:bg-surface-muted ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  const disabled =
    'inline-flex min-h-11 items-center rounded-xl border border-border px-4 font-medium opacity-50';

  return (
    <nav
      aria-label={dict.orders.pagination.label}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      {hasPrevious ? (
        <Link href={ordersHref(locale, { status, page: page - 1 })} rel="prev" className={link}>
          {dict.orders.pagination.previous}
        </Link>
      ) : (
        <span aria-disabled="true" className={disabled}>
          {dict.orders.pagination.previous}
        </span>
      )}
      <span aria-live="polite" className="text-muted-foreground">
        {formatMessage(dict.orders.pagination.pageOf, { page, total: Math.max(totalPages, 1) })}
      </span>
      {hasNext ? (
        <Link href={ordersHref(locale, { status, page: page + 1 })} rel="next" className={link}>
          {dict.orders.pagination.next}
        </Link>
      ) : (
        <span aria-disabled="true" className={disabled}>
          {dict.orders.pagination.next}
        </span>
      )}
    </nav>
  );
}

// On narrow screens every row becomes a small card (labels come from `data-label`); from `sm` up
// it is a regular table.
const CELL =
  'flex justify-between gap-3 py-1 before:text-sm before:text-muted-foreground before:content-[attr(data-label)] ' +
  'sm:table-cell sm:px-3 sm:py-3 sm:before:hidden';

function OrdersTable({ orders }: { orders: OrderPage['items'] }) {
  const { dict, locale } = useI18n();
  const columns = dict.orders.columns;
  return (
    <table className="block w-full text-left sm:table">
      <thead className="hidden sm:table-header-group">
        <tr className="border-b border-border text-sm text-muted-foreground">
          <th scope="col" className="px-3 py-2 font-medium">
            {columns.number}
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            {columns.status}
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            {columns.items}
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            {columns.total}
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            {columns.created}
          </th>
        </tr>
      </thead>
      <tbody className="block sm:table-row-group">
        {orders.map((order) => (
          <tr
            key={order.id}
            className="mb-3 block rounded-xl border border-border bg-surface px-3 py-2 sm:mb-0 sm:table-row sm:rounded-none sm:border-0 sm:border-b sm:bg-transparent sm:px-0 sm:py-0 sm:hover:bg-surface-muted"
          >
            <td data-label={columns.number} className={CELL}>
              <Link
                href={orderHref(locale, order.id)}
                className="min-h-6 font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
              >
                {order.number}
              </Link>
            </td>
            <td data-label={columns.status} className={CELL}>
              <StatusBadge status={order.status} />
            </td>
            <td data-label={columns.items} className={cx(CELL, 'sm:text-right')}>
              {order.item_count}
            </td>
            <td
              data-label={columns.total}
              className={cx(CELL, 'sm:text-right sm:whitespace-nowrap')}
            >
              {formatUZS(order.total_uzs, locale)}
            </td>
            <td data-label={columns.created} className={cx(CELL, 'sm:whitespace-nowrap')}>
              {formatDateTime(order.created_at)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The orders list: status filter and page come from the URL, so they survive reload and back. */
export function OrdersList() {
  const { dict } = useI18n();
  const { apiFetch } = useSession();
  const params = useSearchParams();
  const status = parseStatusFilter(params.get('status'));
  const page = parsePage(params.get('page'));

  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${status ?? 'all'}|${String(page)}|${String(attempt)}`;

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ page: String(page), page_size: String(ORDERS_PAGE_SIZE) });
    if (status !== null) query.set('status', status);

    apiFetch(`/admin/orders?${query.toString()}`)
      .then(async (response) => {
        if (!response.ok) throw await ApiRequestError.fromResponse(response);
        return readJson<OrderPage>(response);
      })
      .then((result) => {
        if (!cancelled) setLoaded({ key, page: result, error: null });
      })
      .catch((cause: unknown) => {
        const error = cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause);
        if (!cancelled) setLoaded({ key, page: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, status, page, key]);

  // A result that belongs to an earlier filter/page/retry is never shown: the list is "loading".
  const current = loaded?.key === key ? loaded : null;

  let body;
  if (current === null) {
    body = (
      <div role="status" aria-label={dict.orders.loading} className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (current.error !== null) {
    body = (
      <ErrorState
        title={dict.errors.title}
        description={readErrorMessage(dict, current.error)}
        {...(current.error.code === 'forbidden'
          ? {}
          : { retryLabel: dict.errors.retry, onRetry: () => setAttempt((value) => value + 1) })}
      />
    );
  } else {
    const result = current.page;
    body =
      result.items.length === 0 ? (
        <EmptyState title={status === null ? dict.orders.empty : dict.orders.emptyFiltered} />
      ) : (
        <OrdersTable orders={result.items} />
      );
    if (result.total_pages > 1 || page > 1) {
      body = (
        <>
          {body}
          <Pagination status={status} page={page} totalPages={result.total_pages} />
        </>
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">{dict.orders.title}</h1>
      <StatusFilter active={status} />
      {body}
    </div>
  );
}
