'use client';

import type { OrderPage, OrderSummary } from '@muniramarket/contracts';
import { EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatDateTime } from '@/i18n/date';
import { formatMessage, formatPlural } from '@/i18n/format';
import { ApiRequestError } from '@/lib/api/errors';
import { listOrders } from '@/lib/api/orders';
import { useSession } from '@/lib/session';
import { Pagination } from '../pagination';
import { SignInPrompt } from '../sign-in-prompt';
import { StatusBadge } from '../status-badge';
import { FOCUS_RING, LINK_BUTTON_PRIMARY, PRESS } from '../ui-classes';

export const ORDERS_PAGE_SIZE = 10;

type Load = { kind: 'loading' } | { kind: 'ready'; page: OrderPage } | { kind: 'failed' };

function OrdersSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function OrderCard({ order }: { order: OrderSummary }) {
  const { dict, locale } = useI18n();
  return (
    <li>
      <Link
        href={`/${locale}/orders/${encodeURIComponent(order.id)}`}
        data-testid="order-card"
        className={`flex min-h-11 flex-col gap-2 rounded-xl border border-border bg-surface p-4 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
      >
        <span className="flex items-start justify-between gap-3">
          <span data-user-text className="min-w-0 font-semibold">
            {formatMessage(dict.orders.orderNumber, { number: order.number })}
          </span>
          <StatusBadge status={order.status} label={dict.orders.status[order.status]} />
        </span>
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 text-sm text-muted-foreground">
            <time dateTime={order.created_at}>{formatDateTime(order.created_at)}</time>
            {' · '}
            {formatPlural(dict.orders.items, order.item_count, locale)}
          </span>
          <span data-money data-testid="order-total" className="shrink-0 text-lg font-bold">
            {formatUZS(order.total_uzs, locale)}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The customer's order history, newest first, ten per page (`?page=` in the URL). */
export function OrdersList({ page }: { page: number }) {
  const { dict, locale } = useI18n();
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const fetchOrders = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      setLoad({
        kind: 'ready',
        page: await listOrders(apiFetch, { page, pageSize: ORDERS_PAGE_SIZE }),
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry, page]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `fetchOrders` only sets state asynchronously, after the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOrders();
  }, [status, fetchOrders]);

  if (status !== 'authenticated') {
    return status === 'loading' ? <OrdersSkeleton label={dict.orders.loading} /> : <SignInPrompt />;
  }
  if (load.kind === 'loading') return <OrdersSkeleton label={dict.orders.loading} />;
  if (load.kind === 'failed') {
    return (
      <ErrorState
        title={dict.orders.loadFailed}
        retryLabel={dict.orders.retry}
        onRetry={() => void fetchOrders()}
      />
    );
  }

  const result = load.page;
  if (result.total === 0) {
    return (
      <EmptyState
        title={dict.orders.emptyTitle}
        description={dict.orders.emptyHint}
        action={
          <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
            {dict.orders.toCatalog}
          </Link>
        }
      />
    );
  }
  if (result.items.length === 0) {
    // A page past the end (for example an old bookmark after orders were removed).
    return (
      <EmptyState
        title={formatMessage(dict.orders.pageEmpty, { page })}
        action={
          <Link href={`/${locale}/orders`} className={LINK_BUTTON_PRIMARY}>
            {dict.orders.firstPage}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3" aria-label={dict.orders.title}>
        {result.items.map((order) => (
          <OrderCard key={order.id} order={order} />
        ))}
      </ul>
      <Pagination
        page={result.page}
        totalPages={result.total_pages}
        hrefFor={(next) => `/${locale}/orders${next > 1 ? `?page=${String(next)}` : ''}`}
        dict={dict}
      />
    </div>
  );
}
