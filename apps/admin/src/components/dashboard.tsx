'use client';

import type { Dashboard } from '@muniramarket/contracts';
import { Button, Skeleton, cx, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { formatCount, formatDate } from '@/lib/format';
import { ordersHref } from '@/lib/orders';
import { useApiResource } from '@/lib/use-api-resource';
import { CARD } from './ui/classes';
import { PageHeader } from './ui/page-header';
import { ResourceView } from './ui/resource-view';
import { Spinner } from './ui/spinner';

function Stat({
  label,
  value,
  hint,
  testId,
  href,
  attention = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  testId: string;
  href?: string;
  /** Something is waiting for staff (new orders): brand tint, so it is the first thing seen. */
  attention?: boolean;
}) {
  const body = (
    <>
      <dt className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {href === undefined ? null : (
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 20 20"
            className="size-4 shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
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
        )}
      </dt>
      <dd
        className={cx(
          'text-2xl font-bold tracking-tight break-words tabular sm:text-3xl',
          attention && 'text-brand-ink',
        )}
        data-testid={testId}
      >
        {value}
      </dd>
      {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
    </>
  );
  const tone = attention ? 'border-primary/40 bg-brand-soft' : '';
  return href === undefined ? (
    <div className={cx(CARD, tone)}>{body}</div>
  ) : (
    <Link
      href={href}
      className={cx(
        CARD,
        tone,
        'group transition-transform duration-150 ease-out hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.99]',
      )}
    >
      {body}
    </Link>
  );
}

function Numbers({ data }: { data: Dashboard }) {
  const { dict, locale } = useI18n();
  const copy = dict.dashboard;
  // Every number below is exactly what the API computed; nothing is summed or averaged here.
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Stat
        label={copy.ordersToday}
        value={formatCount(data.orders_today)}
        testId="stat-orders-today"
      />
      <Stat
        label={copy.newOrders}
        value={formatCount(data.new_orders)}
        hint={copy.newOrdersHint}
        href={ordersHref(locale, { status: 'NEW', page: 1 })}
        testId="stat-new-orders"
        attention={data.new_orders > 0}
      />
      <Stat
        label={copy.gmv}
        value={formatUZS(data.gmv_today_uzs, locale)}
        hint={copy.gmvHint}
        testId="stat-gmv"
      />
      <Stat
        label={copy.averageOrderValue}
        value={formatUZS(data.average_order_value_uzs, locale)}
        testId="stat-aov"
      />
      <Stat
        label={copy.cancelledToday}
        value={formatCount(data.cancelled_today)}
        testId="stat-cancelled"
      />
    </dl>
  );
}

/** Landing page: today's numbers for operators and admins, as computed by `GET /admin/dashboard`. */
export function DashboardView() {
  const { dict } = useI18n();
  const resource = useApiResource<Dashboard>('/admin/dashboard');

  return (
    <div className="flex flex-col gap-4">
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
            onClick={resource.reload}
            disabled={resource.fetching}
            aria-busy={resource.fetching}
          >
            {resource.fetching ? <Spinner className="size-4" /> : null}
            {dict.dashboard.refresh}
          </Button>
        }
      />
      <ResourceView
        resource={resource}
        loadingLabel={dict.dashboard.loading}
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        }
      >
        {(data) => <Numbers data={data} />}
      </ResourceView>
    </div>
  );
}
