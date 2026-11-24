'use client';

import type { OrderPage, OrderStatusGroup, OrderSummary } from '@muniramarket/contracts';
import { EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Dictionary } from '@/i18n';
import { useI18n } from '@/i18n/context';
import { formatDateTime } from '@/i18n/date';
import { formatMessage, formatPlural } from '@/i18n/format';
import { ApiRequestError } from '@/lib/api/errors';
import { listOrders } from '@/lib/api/orders';
import { useSession } from '@/lib/session';
import { Pagination } from '../pagination';
import { SignInPrompt } from '../sign-in-prompt';
import { StatusBadge } from '../status-badge';
import { EmptyPanel } from '../empty-panel';
import { ProductImage } from '../product-image';
import { ChevronRightIcon, ReceiptIcon, TruckIcon } from '../icons';
import { FOCUS_RING, GROUP, LINK_BUTTON_PRIMARY, ROWS } from '../ui-classes';
import { ordersHref } from '@/lib/orders/status-group';

export const ORDERS_PAGE_SIZE = 10;

type Load = { kind: 'loading' } | { kind: 'ready'; page: OrderPage } | { kind: 'failed' };

function OrdersSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className={`${GROUP} flex flex-col gap-5 p-4`}>
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Up to four product photos of the order, overlapping slightly, and `+N` for the rest. */
export function OrderThumbnails({ order }: { order: OrderSummary }) {
  const { dict, locale } = useI18n();
  const thumbs = order.thumbnails;
  if (thumbs.length === 0) return null;
  const extra = order.item_count - thumbs.length;
  return (
    <span aria-hidden="true" data-testid="order-thumbnails" className="flex items-center">
      {thumbs.map((thumb, index) => (
        <span
          key={`${thumb.product_id ?? 'gone'}-${String(index)}`}
          className="-ml-2 first:ml-0 rounded-[12px] ring-2 ring-surface"
          style={{ zIndex: thumbs.length - index }}
        >
          <ProductImage
            src={thumb.image_url}
            name={locale === 'ru' ? thumb.name_ru : thumb.name_uz}
            toneKey={thumb.product_id ?? thumb.name_uz}
            sizes="44px"
            className="size-11 rounded-[12px]"
          />
        </span>
      ))}
      {extra > 0 ? (
        <span className="-ml-2 flex size-11 items-center justify-center rounded-[12px] bg-surface-muted text-[13px] font-semibold text-muted-foreground ring-2 ring-surface tabular-nums">
          {formatMessage(dict.orderTabs.moreItems, { count: extra })}
        </span>
      ) : null}
    </span>
  );
}

function OrderCard({ order }: { order: OrderSummary }) {
  const { dict, locale } = useI18n();
  return (
    <li>
      <Link
        href={`/${locale}/orders/${encodeURIComponent(order.id)}`}
        data-testid="order-card"
        className={`-mx-4 flex min-h-11 items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="flex min-w-0 items-start justify-between gap-3">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span data-user-text className="min-w-0 font-semibold">
                {formatMessage(dict.orders.orderNumber, { number: order.number })}
              </span>
              <span className="min-w-0 text-sm text-muted-foreground">
                <time dateTime={order.created_at}>{formatDateTime(order.created_at)}</time>
                {' · '}
                {formatPlural(dict.orders.items, order.item_count, locale)}
              </span>
            </span>
            <StatusBadge status={order.status} label={dict.orders.status[order.status]} />
          </span>
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <OrderThumbnails order={order} />
            <span
              data-money
              data-testid="order-total"
              className="ml-auto shrink-0 text-[17px] font-bold"
            >
              {formatUZS(order.total_uzs, locale)}
            </span>
          </span>
        </span>
        <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

type TabKey = keyof Dictionary['orderTabs'];

const EMPTY: Record<OrderStatusGroup, { title: TabKey; hint: TabKey }> = {
  all: { title: 'emptyAll', hint: 'emptyAllHint' },
  active: { title: 'emptyActive', hint: 'emptyActiveHint' },
  delivering: { title: 'emptyDelivering', hint: 'emptyDeliveringHint' },
  done: { title: 'emptyDone', hint: 'emptyDoneHint' },
  cancelled: { title: 'emptyCancelled', hint: 'emptyCancelledHint' },
};

/**
 * The customer's order history, newest first, ten per page, filtered by status group
 * (`?status=` and `?page=` in the URL; the filtering and counting happen on the server).
 */
export function OrdersList({
  page,
  statusGroup = 'all',
}: {
  page: number;
  statusGroup?: OrderStatusGroup;
}) {
  const { dict, locale } = useI18n();
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const fetchOrders = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      setLoad({
        kind: 'ready',
        page: await listOrders(apiFetch, { page, pageSize: ORDERS_PAGE_SIZE, statusGroup }),
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry, page, statusGroup]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `fetchOrders` only sets state asynchronously, after the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOrders();
  }, [status, fetchOrders]);

  if (status !== 'authenticated') {
    return status === 'loading' ? (
      <OrdersSkeleton label={dict.orders.loading} />
    ) : (
      <SignInPrompt variant="screen" />
    );
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
    const empty = EMPTY[statusGroup];
    return (
      <EmptyPanel
        icon={statusGroup === 'delivering' ? <TruckIcon /> : <ReceiptIcon />}
        title={dict.orderTabs[empty.title]}
        description={dict.orderTabs[empty.hint]}
        action={
          statusGroup === 'all' ? (
            <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
              {dict.orders.toCatalog}
            </Link>
          ) : undefined
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
          <Link href={ordersHref(locale, statusGroup)} className={LINK_BUTTON_PRIMARY}>
            {dict.orders.firstPage}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul
        className={`${GROUP} ${ROWS} flex flex-col overflow-hidden px-4`}
        aria-label={dict.orders.title}
      >
        {result.items.map((order) => (
          <OrderCard key={order.id} order={order} />
        ))}
      </ul>
      <Pagination
        page={result.page}
        totalPages={result.total_pages}
        hrefFor={(next) => ordersHref(locale, statusGroup, next)}
        dict={dict}
      />
    </div>
  );
}
