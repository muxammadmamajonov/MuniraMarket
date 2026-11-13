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
import { PageHeader } from './ui/page-header';
import { CHIP, CHIP_OFF, CHIP_ON, CHIP_RAIL, LINK_BUTTON } from './ui/classes';
import { DataTable, type Column } from './ui/data-table';
import { ProductPhoto } from './ui/product-photo';

type Loaded =
  | { key: string; page: OrderPage; error: null }
  | { key: string; page: null; error: ApiRequestError };

function StatusFilter({ active }: { active: OrderStatus | null }) {
  const { dict, locale } = useI18n();
  const options: Array<OrderStatus | null> = [null, ...ORDER_STATUSES];
  return (
    <nav aria-label={dict.orders.filterLabel}>
      <ul className={CHIP_RAIL}>
        {options.map((option) => {
          const selected = option === active;
          return (
            <li key={option ?? 'all'}>
              <Link
                href={ordersHref(locale, { status: option, page: 1 })}
                aria-current={selected ? 'true' : undefined}
                className={cx(CHIP, selected ? CHIP_ON : CHIP_OFF)}
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
  const link = LINK_BUTTON;
  const disabled =
    'inline-flex min-h-11 items-center rounded-2xl bg-surface/60 px-4 font-semibold text-muted-foreground';

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

/** Up to three product cut-outs, overlapping, so an order is recognisable at a glance. */
function Thumbnails({ order }: { order: OrderPage['items'][number] }) {
  // An order without thumbnails keeps one placeholder, so the numbers stay in one column.
  const shown = order.thumbnails.length === 0 ? [null] : order.thumbnails.slice(0, 3);
  return (
    <span aria-hidden="true" className="flex w-24 shrink-0 -space-x-3">
      {shown.map((thumb, index) => (
        <ProductPhoto
          key={`${thumb?.product_id ?? 'none'}-${String(index)}`}
          src={thumb?.image_url ?? null}
          className="w-10 rounded-[10px] ring-2 ring-surface"
        />
      ))}
    </span>
  );
}

function OrdersTable({ orders }: { orders: OrderPage['items'] }) {
  const { dict, locale } = useI18n();
  const columns = dict.orders.columns;
  const table: Array<Column<OrderPage['items'][number]>> = [
    {
      id: 'number',
      header: columns.number,
      primary: true,
      cell: (order) => (
        <span className="flex items-center gap-3">
          <Thumbnails order={order} />
          <Link
            href={orderHref(locale, order.id)}
            className="min-h-6 font-semibold tabular underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {order.number}
          </Link>
        </span>
      ),
    },
    {
      id: 'status',
      header: columns.status,
      cell: (order) => <StatusBadge status={order.status} />,
    },
    {
      id: 'items',
      header: columns.items,
      numeric: true,
      cell: (order) => order.item_count,
    },
    {
      id: 'total',
      header: columns.total,
      numeric: true,
      nowrap: true,
      cell: (order) => <span className="font-semibold">{formatUZS(order.total_uzs, locale)}</span>,
    },
    {
      id: 'created',
      header: columns.created,
      nowrap: true,
      cell: (order) => (
        <span className="text-muted-foreground">{formatDateTime(order.created_at)}</span>
      ),
    },
  ];
  return (
    <DataTable
      caption={dict.orders.title}
      columns={table}
      rows={orders}
      rowKey={(order) => order.id}
    />
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
      <PageHeader title={dict.orders.title} />
      <StatusFilter active={status} />
      {body}
    </div>
  );
}
