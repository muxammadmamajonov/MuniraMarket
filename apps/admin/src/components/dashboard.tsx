'use client';

import type { Dashboard, OrderPage } from '@muniramarket/contracts';
import { Button, Skeleton, cx, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { formatCount, formatDate, formatDateTime } from '@/lib/format';
import { orderHref, ordersHref } from '@/lib/orders';
import { useApiResource } from '@/lib/use-api-resource';
import { StatusBadge } from './status-badge';
import { GROUP, PRESS, ROWS, SECTION_TITLE } from './ui/classes';
import { PageHeader } from './ui/page-header';
import { ProductPhoto } from './ui/product-photo';
import { ResourceView } from './ui/resource-view';
import { Spinner } from './ui/spinner';

/** How many of the latest orders the dashboard lists. */
const RECENT_ORDERS = 6;

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      className={cx('size-5 shrink-0', className)}
    >
      <path
        d="M7.5 5l5 5-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One of today's numbers: a white group, the label above, the number large. */
function Stat({
  label,
  value,
  hint,
  testId,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  testId: string;
  /** A money amount: the full row on phones, where half a row would break the number. */
  wide?: boolean;
}) {
  return (
    <div
      className={cx(GROUP, 'flex min-w-0 flex-col gap-1 p-4 sm:p-5', wide && 'max-sm:col-span-2')}
    >
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd
        className="text-xl leading-7 font-bold tracking-[-0.02em] break-words tabular sm:text-[28px] sm:leading-8"
        data-testid={testId}
      >
        {value}
      </dd>
      {hint === undefined ? null : <p className="text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * New orders, the one number staff act on: the shop's red when something is waiting (white type,
 * AA on the primary), a quiet white group when nothing is. The whole card opens the NEW filter.
 */
function NewOrders({ count }: { count: number }) {
  const { dict, locale } = useI18n();
  const copy = dict.dashboard;
  const waiting = count > 0;
  return (
    <Link
      href={ordersHref(locale, { status: 'NEW', page: 1 })}
      className={cx(
        'group relative flex min-h-36 min-w-0 sm:min-h-40 flex-col justify-between gap-4 overflow-hidden rounded-3xl p-5 sm:p-6',
        PRESS,
        FOCUS,
        waiting
          ? 'bg-primary text-primary-foreground hover:bg-primary-hover'
          : 'bg-surface text-foreground hover:bg-surface-muted',
      )}
    >
      <dt className="flex items-center justify-between gap-2 text-[15px] font-semibold">
        <span className="min-w-0 break-words">{copy.newOrders}</span>
        <Chevron className="transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
      </dt>
      <dd className="flex flex-col gap-1">
        <span
          className="text-[56px] leading-none font-bold tracking-[-0.04em] tabular"
          data-testid="stat-new-orders"
        >
          {formatCount(count)}
        </span>
        <span
          className={cx(
            'text-sm',
            waiting ? 'text-primary-foreground/85' : 'text-muted-foreground',
          )}
        >
          {copy.newOrdersHint}
        </span>
      </dd>
    </Link>
  );
}

function Numbers({ data }: { data: Dashboard }) {
  const { dict, locale } = useI18n();
  const copy = dict.dashboard;
  // Every number below is exactly what the API computed; nothing is summed or averaged here.
  return (
    <dl className="grid gap-3 lg:grid-cols-3">
      <NewOrders count={data.new_orders} />
      <div className="grid grid-flow-row-dense grid-cols-2 gap-3 lg:col-span-2">
        <Stat
          label={copy.ordersToday}
          value={formatCount(data.orders_today)}
          testId="stat-orders-today"
        />
        <Stat
          label={copy.gmv}
          value={formatUZS(data.gmv_today_uzs, locale)}
          hint={copy.gmvHint}
          testId="stat-gmv"
          wide
        />
        <Stat
          label={copy.averageOrderValue}
          value={formatUZS(data.average_order_value_uzs, locale)}
          testId="stat-aov"
          wide
        />
        <Stat
          label={copy.cancelledToday}
          value={formatCount(data.cancelled_today)}
          testId="stat-cancelled"
        />
      </div>
    </dl>
  );
}

/** The latest orders, newest first: photos, number, status, total; each row opens the order. */
function RecentOrders({ page }: { page: OrderPage }) {
  const { dict, locale } = useI18n();
  if (page.items.length === 0) {
    return <p className="px-5 pb-5 text-muted-foreground">{dict.orders.empty}</p>;
  }
  return (
    <ul className={cx(ROWS, 'px-2 pb-2')} data-testid="recent-orders">
      {page.items.map((order) => (
        <li key={order.id}>
          <Link
            href={orderHref(locale, order.id)}
            className={cx(
              'flex min-h-16 items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-surface-muted/70',
              PRESS,
              FOCUS,
            )}
          >
            <span aria-hidden="true" className="flex w-24 shrink-0 -space-x-3">
              {(order.thumbnails.length === 0 ? [null] : order.thumbnails.slice(0, 3)).map(
                (thumb, index) => (
                  <ProductPhoto
                    key={`${thumb?.product_id ?? 'none'}-${String(index)}`}
                    src={thumb?.image_url ?? null}
                    className="w-10 rounded-[10px] ring-2 ring-surface"
                  />
                ),
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold tabular">{order.number}</span>
              <span className="text-[13px] text-muted-foreground tabular">
                {formatDateTime(order.created_at)}
              </span>
            </span>
            <StatusBadge status={order.status} />
            <span className="hidden w-32 shrink-0 text-right font-semibold whitespace-nowrap tabular sm:block">
              {formatUZS(order.total_uzs, locale)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Landing page for operators and admins: today's numbers, as computed by `GET /admin/dashboard`,
 * with the new orders up front, and the latest orders below so the next one is a click away.
 */
export function DashboardView() {
  const { dict, locale } = useI18n();
  const resource = useApiResource<Dashboard>('/admin/dashboard');
  const recent = useApiResource<OrderPage>(
    `/admin/orders?page=1&page_size=${String(RECENT_ORDERS)}`,
  );
  const fetching = resource.fetching || recent.fetching;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={dict.dashboard.title}
        subtitle={
          resource.data === null
            ? undefined
            : formatMessage(dict.dashboard.asOf, { date: formatDate(resource.data.date) })
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              resource.reload();
              recent.reload();
            }}
            disabled={fetching}
            aria-busy={fetching}
          >
            {fetching ? <Spinner className="size-4" /> : null}
            {dict.dashboard.refresh}
          </Button>
        }
      />
      <ResourceView
        resource={resource}
        loadingLabel={dict.dashboard.loading}
        skeleton={
          <div className="grid gap-3 lg:grid-cols-3">
            <Skeleton className="h-40 w-full rounded-3xl" />
            <div className="grid grid-cols-2 gap-3 lg:col-span-2">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-[6.5rem] w-full rounded-3xl" />
              ))}
            </div>
          </div>
        }
      >
        {(data) => <Numbers data={data} />}
      </ResourceView>

      <section aria-labelledby="recent-orders-title" className={GROUP}>
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          <h2 id="recent-orders-title" className={cx(SECTION_TITLE, 'min-w-0 truncate')}>
            {dict.dashboard.recentTitle}
          </h2>
          <Link
            href={ordersHref(locale, { status: null, page: 1 })}
            className={cx(
              'inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 text-[15px] font-semibold whitespace-nowrap text-brand-ink',
              FOCUS,
            )}
          >
            {dict.dashboard.recentAll}
            <Chevron className="size-4" />
          </Link>
        </div>
        <ResourceView
          resource={recent}
          loadingLabel={dict.orders.loading}
          skeleton={
            <div className="flex flex-col gap-2 px-5 pb-5">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-14 w-full rounded-2xl" />
              ))}
            </div>
          }
        >
          {(page) => <RecentOrders page={page} />}
        </ResourceView>
      </section>
    </div>
  );
}
