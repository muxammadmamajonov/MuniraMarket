'use client';

import type { Dashboard } from '@muniramarket/contracts';
import { Button, Skeleton, formatUZS } from '@muniramarket/ui';
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

function Stat({
  label,
  value,
  hint,
  testId,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  testId: string;
  href?: string;
}) {
  const body = (
    <>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-bold tracking-tight break-words tabular" data-testid={testId}>
        {value}
      </dd>
      {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
    </>
  );
  return href === undefined ? (
    <div className={CARD}>{body}</div>
  ) : (
    <Link
      href={href}
      className={`${CARD} transition-[background-color,transform] duration-150 ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.99]`}
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
          <Button variant="secondary" onClick={resource.reload} disabled={resource.fetching}>
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
