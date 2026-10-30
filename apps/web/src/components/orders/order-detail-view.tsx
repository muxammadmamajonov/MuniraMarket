'use client';

import type { OrderDetail, OrderLine } from '@muniramarket/contracts';
import { Button, EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatDateTime } from '@/i18n/date';
import { formatMessage, formatPlural } from '@/i18n/format';
import { ApiRequestError } from '@/lib/api/errors';
import { getOrder } from '@/lib/api/orders';
import { useSession } from '@/lib/session';
import { SignInPrompt } from '../sign-in-prompt';
import { StatusBadge } from '../status-badge';
import { CARD, LINK_BUTTON_PRIMARY, LINK_BUTTON_SECONDARY } from '../ui-classes';
import { CancelOrderSheet } from './cancel-order-sheet';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; order: OrderDetail }
  | { kind: 'not_found' }
  | { kind: 'failed' };

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${CARD} flex min-w-0 flex-col gap-3`}>
      <h2 id={id} className="text-lg font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A label/value row whose value is the customer's own text: it wraps anywhere, never overflows. */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === '') return null;
  return (
    <div className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-user-text className="min-w-0">
        {value}
      </dd>
    </div>
  );
}

function LineRow({ line }: { line: OrderLine }) {
  const { dict, locale } = useI18n();
  const name = locale === 'ru' ? line.name_ru : line.name_uz;
  return (
    <li
      data-testid="order-line"
      className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
    >
      <div className="min-w-0">
        <p data-user-text className="font-medium">
          {name}
        </p>
        <p className="text-sm text-muted-foreground">
          {formatMessage(dict.orders.detail.lineBreakdown, {
            quantity: line.quantity,
            price: formatUZS(line.unit_price_uzs, locale),
            unit: dict.units[line.unit],
          })}
        </p>
        {line.product_id === null ? (
          <p className="text-sm text-muted-foreground">{dict.orders.detail.productRemoved}</p>
        ) : null}
      </div>
      <span data-money className="shrink-0 font-semibold">
        {formatUZS(line.line_total_uzs, locale)}
      </span>
    </li>
  );
}

function Timeline({ order }: { order: OrderDetail }) {
  const { dict } = useI18n();
  const entries =
    order.history.length > 0 ? order.history : [{ status: order.status, at: order.created_at }];
  return (
    <ol className="flex flex-col" data-testid="timeline">
      {entries.map((entry, index) => {
        const current = index === entries.length - 1;
        return (
          <li
            key={`${entry.status}-${entry.at}`}
            aria-current={current ? 'step' : undefined}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            <span aria-hidden="true" className="flex w-3 shrink-0 flex-col items-center">
              <span
                className={`mt-1.5 size-3 shrink-0 rounded-full ${current ? 'bg-primary' : 'border-2 border-border bg-surface'}`}
              />
              {index === entries.length - 1 ? null : <span className="mt-1 w-px grow bg-border" />}
            </span>
            <div className="min-w-0">
              <p className={current ? 'font-bold' : 'font-medium'}>
                {dict.orders.status[entry.status]}
                {current ? <span className="sr-only"> — {dict.orders.detail.current}</span> : null}
              </p>
              <p className="text-sm text-muted-foreground">
                <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface OrderDetailViewProps {
  id: string;
  /** `?placed=1`: the customer was just sent here after placing the order. */
  placed: boolean;
}

/** One order: status and timeline, lines, totals, address, recipient, payment and cancellation. */
export function OrderDetailView({ id, placed }: OrderDetailViewProps) {
  const { dict, locale } = useI18n();
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cancelledNotice, setCancelledNotice] = useState(false);

  const fetchOrder = useCallback(
    async (options: { quiet: boolean } = { quiet: false }) => {
      if (!options.quiet) setLoad({ kind: 'loading' });
      try {
        setLoad({ kind: 'ready', order: await getOrder(apiFetch, id) });
      } catch (error) {
        if (error instanceof ApiRequestError) {
          if (error.code === 'order_not_found' || error.code === 'validation_error') {
            setLoad({ kind: 'not_found' });
            return;
          }
          if (error.code === 'session_required') retry();
        }
        setLoad({ kind: 'failed' });
      }
    },
    [apiFetch, retry, id],
  );

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `fetchOrder` only sets state asynchronously, after the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOrder();
  }, [status, fetchOrder]);

  if (status !== 'authenticated') {
    return status === 'loading' ? (
      <DetailSkeleton label={dict.orders.detail.loadingLabel} />
    ) : (
      <SignInPrompt />
    );
  }
  if (load.kind === 'loading') return <DetailSkeleton label={dict.orders.detail.loadingLabel} />;
  if (load.kind === 'not_found') {
    return (
      <EmptyState
        title={dict.orders.detail.notFoundTitle}
        description={dict.orders.detail.notFoundMessage}
        action={
          <Link href={`/${locale}/orders`} className={LINK_BUTTON_PRIMARY}>
            {dict.orders.detail.back}
          </Link>
        }
      />
    );
  }
  if (load.kind === 'failed') {
    return (
      <ErrorState
        title={dict.orders.loadFailed}
        retryLabel={dict.orders.retry}
        onRetry={() => void fetchOrder()}
      />
    );
  }

  const { order } = load;
  const d = dict.orders.detail;
  const { address } = order;
  const districtName = locale === 'ru' ? address.district_name_ru : address.district_name_uz;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {placed ? (
        <div
          role="status"
          data-testid="placed-banner"
          className="mm-enter flex flex-col gap-1 rounded-xl border border-green-700 bg-green-50 p-4 text-green-950 dark:border-green-400 dark:bg-green-950 dark:text-green-100"
        >
          <p className="font-bold">{d.placedTitle}</p>
          <p className="text-sm">{d.placedHint}</p>
        </div>
      ) : null}
      {cancelledNotice ? (
        <p
          role="status"
          data-testid="cancelled-notice"
          className="mm-enter rounded-xl border border-border bg-surface-muted p-4 font-medium"
        >
          {dict.orders.cancel.done}
        </p>
      ) : null}

      <header className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h1
            data-user-text
            data-testid="order-number"
            className="min-w-0 text-2xl font-bold tracking-tight"
          >
            {formatMessage(dict.orders.orderNumber, { number: order.number })}
          </h1>
          <StatusBadge
            status={order.status}
            label={dict.orders.status[order.status]}
            className="mt-1"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          <time dateTime={order.created_at}>{formatDateTime(order.created_at)}</time>
          {' · '}
          {formatPlural(dict.orders.items, order.item_count, locale)}
        </p>
      </header>

      <div className="grid min-w-0 gap-4 md:grid-cols-2 md:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <Section id="order-status" title={d.timeline}>
            <Timeline order={order} />
            {order.status === 'CANCELLED' ? (
              <div className="flex flex-col gap-1 border-t border-border pt-3">
                <p className="font-medium">{d.cancelReasonHeading}</p>
                {order.cancel_reason === null ? (
                  <p className="text-muted-foreground">{d.cancelledNotice}</p>
                ) : (
                  <p data-user-text data-testid="cancel-reason">
                    {order.cancel_reason}
                  </p>
                )}
              </div>
            ) : null}
          </Section>

          <Section id="order-items" title={d.itemsHeading}>
            <ul className="flex flex-col divide-y divide-border">
              {order.items.map((line) => (
                <LineRow key={`${line.sku}-${line.name_uz}`} line={line} />
              ))}
            </ul>
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <p className="flex items-baseline justify-between gap-3">
                <span>{d.subtotal}</span>
                <span data-money className="shrink-0">
                  {formatUZS(order.subtotal_uzs, locale)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3">
                <span>{d.deliveryFee}</span>
                <span data-money data-testid="order-delivery" className="shrink-0">
                  {order.delivery_fee_uzs === 0
                    ? d.free
                    : formatUZS(order.delivery_fee_uzs, locale)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3 text-lg font-bold">
                <span>{d.total}</span>
                <span data-money data-testid="order-total" className="shrink-0">
                  {formatUZS(order.total_uzs, locale)}
                </span>
              </p>
            </div>
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section id="order-delivery" title={d.deliveryHeading}>
            <dl className="flex flex-col gap-1.5">
              <Fact label={d.district} value={districtName} />
              <Fact label={d.street} value={address.street} />
              <Fact label={d.house} value={address.house} />
              <Fact label={d.apartment} value={address.apartment} />
              <Fact label={d.entrance} value={address.entrance} />
              <Fact label={d.floor} value={address.floor} />
              <Fact label={d.landmark} value={address.landmark} />
            </dl>
          </Section>

          <Section id="order-recipient" title={d.recipientHeading}>
            <dl className="flex flex-col gap-1.5">
              <Fact label={d.name} value={order.recipient_name} />
              <Fact label={d.phone} value={order.recipient_phone} />
            </dl>
          </Section>

          <Section id="order-payment" title={d.paymentHeading}>
            <p>{dict.orders.payment[order.payment_method]}</p>
          </Section>

          {order.comment === null || order.comment === '' ? null : (
            <Section id="order-comment" title={d.commentHeading}>
              <p data-user-text className="whitespace-pre-line" data-testid="order-comment">
                {order.comment}
              </p>
            </Section>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link href={`/${locale}/orders`} className={LINK_BUTTON_SECONDARY}>
          {d.back}
        </Link>
        {order.can_cancel ? (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => setSheetOpen(true)}
            data-testid="cancel-order"
            className="text-red-700 dark:text-red-400"
          >
            {dict.orders.cancel.button}
          </Button>
        ) : null}
      </div>

      <CancelOrderSheet
        open={sheetOpen}
        orderId={order.id}
        onClose={() => setSheetOpen(false)}
        onCancelled={(updated) => {
          setLoad({ kind: 'ready', order: updated });
          setSheetOpen(false);
          setCancelledNotice(true);
        }}
        onStale={() => void fetchOrder({ quiet: true })}
      />
    </div>
  );
}
