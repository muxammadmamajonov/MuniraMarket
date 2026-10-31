'use client';

import type {
  AdminOrderDetail,
  OrderStatus,
  OrderStatusUpdateRequest,
} from '@muniramarket/contracts';
import { Button, EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { readErrorMessage } from '@/lib/api/error-messages';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { formatDateTime, formatSlotWindow, telHref } from '@/lib/format';
import { ordersHref } from '@/lib/orders';
import { useSession } from '@/lib/session';
import { CancelDialog } from './cancel-dialog';
import { StatusBadge } from './status-badge';

type Loaded =
  | { key: string; order: AdminOrderDetail; error: null }
  | { key: string; order: null; error: ApiRequestError };

type Notice = { kind: 'conflict' | 'updated'; status: OrderStatus };

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const ALERT = 'text-sm text-red-700 dark:text-red-300';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Fields({ rows }: { rows: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OrderBody({ order }: { order: AdminOrderDetail }) {
  const { dict, locale } = useI18n();
  const a = dict.order.address;
  const districtName =
    locale === 'ru' ? order.address.district_name_ru : order.address.district_name_uz;
  const phone = telHref(order.recipient_phone);

  const addressRows: Array<[string, ReactNode]> = [
    [a.district, districtName],
    [a.street, order.address.street],
    [a.house, order.address.house],
  ];
  const optional: Array<[string, string | null]> = [
    [a.apartment, order.address.apartment],
    [a.entrance, order.address.entrance],
    [a.floor, order.address.floor],
    [a.landmark, order.address.landmark],
  ];
  for (const [label, value] of optional) {
    if (value !== null && value !== '') addressRows.push([label, value]);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card title={dict.order.items.title}>
          <ul className="flex flex-col divide-y divide-border">
            {order.items.map((line, index) => (
              <li
                key={`${line.sku}-${String(index)}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    {locale === 'ru' ? line.name_ru : line.name_uz}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {dict.order.items.sku}: {line.sku}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">
                    {line.quantity} {dict.units[line.unit]} ×{' '}
                    {formatUZS(line.unit_price_uzs, locale)}
                  </p>
                  <p className="font-semibold">{formatUZS(line.line_total_uzs, locale)}</p>
                </div>
              </li>
            ))}
          </ul>
          <dl className="flex flex-col gap-1 border-t border-border pt-3">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{dict.order.totals.subtotal}</dt>
              <dd>{formatUZS(order.subtotal_uzs, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{dict.order.totals.delivery}</dt>
              <dd>{formatUZS(order.delivery_fee_uzs, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-lg font-bold">
              <dt>{dict.order.totals.total}</dt>
              <dd>{formatUZS(order.total_uzs, locale)}</dd>
            </div>
          </dl>
        </Card>

        <Card title={dict.order.timeline.title}>
          <ol aria-label={dict.order.timeline.title} className="flex flex-col gap-3">
            {order.history_detail.map((change, index) => (
              <li
                key={`${change.at}-${String(index)}`}
                className="flex flex-col gap-0.5 border-l-2 border-border pl-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusBadge status={change.status} />
                  <span className="text-sm text-muted-foreground">
                    {dict.roles[change.actor_role]}
                  </span>
                  <time dateTime={change.at} className="text-sm text-muted-foreground">
                    {formatDateTime(change.at)}
                  </time>
                </div>
                {change.from_status === null ? (
                  <p className="text-sm">{dict.order.timeline.created}</p>
                ) : null}
                {change.reason !== null && change.reason !== '' ? (
                  <p className="text-sm break-words">
                    {dict.order.timeline.reason}: {change.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card title={dict.order.recipient.title}>
          <Fields
            rows={[
              [dict.order.recipient.name, order.recipient_name],
              [
                dict.order.recipient.phone,
                phone === null ? (
                  order.recipient_phone
                ) : (
                  <a href={phone} className="font-medium underline underline-offset-2">
                    {order.recipient_phone}
                  </a>
                ),
              ],
              [dict.order.payment, dict.payment[order.payment_method]],
              ...(order.delivery_slot === null || order.delivery_slot === undefined
                ? []
                : ([
                    [
                      dict.order.deliverySlot,
                      <span key="slot" data-testid="order-delivery-slot" className="tabular">
                        {formatSlotWindow(
                          order.delivery_slot.date,
                          order.delivery_slot.starts_at,
                          order.delivery_slot.ends_at,
                        )}
                      </span>,
                    ],
                  ] satisfies Array<[string, ReactNode]>)),
              [dict.order.createdAt, formatDateTime(order.created_at)],
            ]}
          />
        </Card>
        <Card title={a.title}>
          <Fields rows={addressRows} />
        </Card>
        {order.comment !== null && order.comment !== '' ? (
          <Card title={dict.order.comment}>
            <p className="break-words whitespace-pre-wrap">{order.comment}</p>
          </Card>
        ) : null}
        {order.cancel_reason !== null && order.cancel_reason !== '' ? (
          <Card title={dict.order.cancelReason}>
            <p className="break-words whitespace-pre-wrap">{order.cancel_reason}</p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** One order: details, history and the status actions the API currently allows. */
export function OrderDetailView({ id }: { id: string }) {
  const { dict, locale } = useI18n();
  const { apiFetch } = useSession();

  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${id}|${String(attempt)}`;

  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelOpener, setCancelOpener] = useState<HTMLElement | null>(null);

  const fetchOrder = useCallback(async (): Promise<AdminOrderDetail> => {
    const response = await apiFetch(`/admin/orders/${encodeURIComponent(id)}`);
    if (!response.ok) throw await ApiRequestError.fromResponse(response);
    return readJson<AdminOrderDetail>(response);
  }, [apiFetch, id]);

  useEffect(() => {
    let cancelled = false;
    fetchOrder()
      .then((order) => {
        if (!cancelled) setLoaded({ key, order, error: null });
      })
      .catch((cause: unknown) => {
        const error = cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause);
        if (!cancelled) setLoaded({ key, order: null, error });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchOrder, key]);

  const current = loaded?.key === key ? loaded : null;
  const order = current?.order ?? null;

  /**
   * Sends one status change. Only one runs at a time (`inFlight` is a ref, so a second click that
   * lands before React re-renders the disabled button is dropped too). Returns whether the dialog
   * that may have triggered it should close.
   */
  const changeStatus = async (target: OrderStatus, reason?: string): Promise<boolean> => {
    if (order === null || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    setActionError(null);

    try {
      const body: OrderStatusUpdateRequest = {
        status: target,
        // The status this screen displayed: if someone else moved the order meanwhile, the API
        // answers 409 instead of silently overwriting their change.
        expected_status: order.status,
        ...(reason === undefined ? {} : { reason }),
      };
      const response = await apiFetch(`/admin/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const updated = await readJson<AdminOrderDetail>(response);
        setLoaded({ key, order: updated, error: null });
        setNotice({ kind: 'updated', status: updated.status });
        return true;
      }

      const error = await ApiRequestError.fromResponse(response);
      if (error.code === 'order_status_conflict') {
        // Somebody else changed the order: show what it is now and let the user decide again.
        const fresh = await fetchOrder();
        setLoaded({ key, order: fresh, error: null });
        setNotice({ kind: 'conflict', status: fresh.status });
        return true;
      }
      if (error.code === 'invalid_status_transition') {
        setActionError(dict.order.errors.invalidTransition);
        return true;
      }
      setActionError(
        error.code === 'forbidden' || error.code === 'rate_limited'
          ? readErrorMessage(dict, error)
          : dict.order.errors.failed,
      );
      return false;
    } catch {
      setActionError(dict.order.errors.failed);
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const back = (
    <Link
      href={ordersHref(locale, { status: null, page: 1 })}
      className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
    >
      ← {dict.order.back}
    </Link>
  );

  if (current === null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div role="status" aria-label={dict.order.loading} className="flex flex-col gap-3">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (order === null) {
    const error = current.error;
    return (
      <div className="flex flex-col gap-4">
        {back}
        {error?.code === 'order_not_found' ? (
          <EmptyState title={dict.order.notFoundTitle} description={dict.order.notFoundMessage} />
        ) : (
          <ErrorState
            title={dict.errors.title}
            description={error === null ? dict.errors.message : readErrorMessage(dict, error)}
            {...(error?.code === 'forbidden'
              ? {}
              : { retryLabel: dict.errors.retry, onRetry: () => setAttempt((value) => value + 1) })}
          />
        )}
      </div>
    );
  }

  const forward = order.allowed_transitions.filter((status) => status !== 'CANCELLED');
  const canCancel = order.allowed_transitions.includes('CANCELLED');
  const errorLine =
    actionError !== null && !cancelOpen ? (
      <p role="alert" className={ALERT}>
        {actionError}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {formatMessage(dict.order.title, { number: order.number })}
        </h1>
        <StatusBadge status={order.status} />
      </div>

      <section
        aria-label={dict.order.actions.title}
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      >
        {notice !== null ? (
          <p role="status" className="font-medium">
            {formatMessage(dict.order.notices[notice.kind], { status: dict.status[notice.status] })}
          </p>
        ) : null}
        {forward.length === 0 && !canCancel ? (
          <p className="text-muted-foreground">{dict.order.actions.none}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {forward.map((status) => (
              <Button key={status} onClick={() => void changeStatus(status)} disabled={pending}>
                {pending ? dict.order.actions.working : dict.actions[status]}
              </Button>
            ))}
            {canCancel ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  setCancelOpener(event.currentTarget);
                  setCancelOpen(true);
                }}
                disabled={pending}
              >
                {dict.order.actions.cancel}
              </Button>
            ) : null}
          </div>
        )}
        {errorLine}
      </section>

      <OrderBody order={order} />

      {cancelOpen && canCancel ? (
        <CancelDialog
          pending={pending}
          error={actionError}
          returnFocusTo={cancelOpener}
          onClose={() => {
            setActionError(null);
            setCancelOpen(false);
          }}
          onConfirm={(reason) => {
            void changeStatus('CANCELLED', reason).then((close) => {
              if (close) setCancelOpen(false);
            });
          }}
        />
      ) : null}
    </div>
  );
}
