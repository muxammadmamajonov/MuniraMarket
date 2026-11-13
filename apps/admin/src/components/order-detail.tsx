'use client';

import {
  yandexGoCourierUrl,
  type AdminOrderDetail,
  type OrderAddress,
  type OrderStatus,
  type OrderStatusUpdateRequest,
} from '@muniramarket/contracts';
import { Button, EmptyState, ErrorState, Skeleton, cx, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { readErrorMessage } from '@/lib/api/error-messages';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { formatDateTime, telHref } from '@/lib/format';
import { ordersHref } from '@/lib/orders';
import { useSession } from '@/lib/session';
import { useIsPhone } from '@/lib/use-phone';
import { CancelDialog } from './cancel-dialog';
import { LINK_BUTTON_PRIMARY } from './ui/classes';
import { AdjustDialog, type OrderLine } from './order-adjust';
import { SwipeActions } from './ui/swipe-actions';
import { StatusBadge } from './status-badge';

type Loaded =
  | { key: string; order: AdminOrderDetail; error: null }
  | { key: string; order: null; error: ApiRequestError };

type Notice = { kind: 'conflict' | 'updated'; status: OrderStatus };

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const ALERT = 'text-sm text-danger';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-3xl bg-surface p-4 sm:p-5">
      <h2 className="text-lg leading-6 font-bold tracking-[-0.01em]">{title}</h2>
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

/**
 * Yandex Go courier link to the delivery point, or `null` for orders placed before addresses had
 * coordinates (and for coordinates the builder rejects).
 */
function courierUrl(address: OrderAddress): string | null {
  const { lat, lon } = address;
  return lat === null || lon === null ? null : yandexGoCourierUrl({ lat, lon });
}

function OrderBody({
  order,
  onAdjust,
}: {
  order: AdminOrderDetail;
  /** Opens the "not enough of this product" dialog for a line (only while it can be adjusted). */
  onAdjust: (line: OrderLine & { product_id: string }, opener: HTMLElement) => void;
}) {
  const { dict, locale } = useI18n();
  const isPhone = useIsPhone();
  const [openLine, setOpenLine] = useState<number | null>(null);
  const a = dict.order.address;
  const phone = telHref(order.recipient_phone);
  const yandexUrl = courierUrl(order.address);

  const addressRows: Array<[string, ReactNode]> = [
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
          <ul className="flex flex-col divide-y divide-hairline">
            {order.items.map((line, index) => {
              const name = locale === 'ru' ? line.name_ru : line.name_uz;
              const adjustable =
                order.can_adjust_items && line.product_id !== null && line.quantity > 0;
              const open = (opener: HTMLElement) =>
                onAdjust({ ...line, product_id: line.product_id ?? '' }, opener);
              const content = (
                <div className="flex items-start justify-between gap-x-4 gap-y-1 py-3">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{name}</p>
                    <p className="text-sm text-muted-foreground">
                      {dict.order.items.sku}: {line.sku}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm text-muted-foreground">
                      {line.quantity} {dict.units[line.unit]} ×{' '}
                      {formatUZS(line.unit_price_uzs, locale)}
                    </p>
                    <p
                      className={cx(
                        'font-semibold',
                        line.quantity === 0 && 'text-muted-foreground line-through',
                      )}
                    >
                      {formatUZS(line.line_total_uzs, locale)}
                    </p>
                    {line.adjusted ? (
                      <p
                        className="text-[13px] font-semibold text-warning"
                        data-testid="line-adjusted"
                      >
                        {formatMessage(dict.order.adjust.adjustedFrom, {
                          quantity: `${String(line.original_quantity)} ${dict.units[line.unit]}`,
                        })}
                      </p>
                    ) : null}
                  </div>
                  {adjustable && !isPhone ? (
                    <button
                      type="button"
                      data-testid="adjust-line"
                      aria-label={`${dict.order.adjust.button}: ${name}`}
                      onClick={(event) => open(event.currentTarget)}
                      className="inline-flex min-h-10 shrink-0 items-center justify-center self-center rounded-2xl bg-warning-soft px-3.5 text-sm font-semibold text-warning transition-transform duration-150 ease-out-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.97]"
                    >
                      {dict.order.adjust.button}
                    </button>
                  ) : null}
                </div>
              );
              return (
                <li key={`${line.sku}-${String(index)}`} className="first:-mt-3 last:-mb-3">
                  {adjustable && isPhone ? (
                    // Phones: the line reads first; "not enough" slides out on a swipe left.
                    <SwipeActions
                      open={openLine === index}
                      onOpenChange={(next) => setOpenLine(next ? index : null)}
                      actions={[
                        {
                          label: dict.order.adjust.button,
                          accessibleName: `${dict.order.adjust.button}: ${name}`,
                          tone: 'danger',
                          testId: 'adjust-line',
                          onSelect: open,
                        },
                      ]}
                    >
                      {content}
                    </SwipeActions>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
          <dl className="flex flex-col gap-1 border-t border-hairline pt-3">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{dict.order.totals.subtotal}</dt>
              <dd>{formatUZS(order.subtotal_uzs, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-lg font-bold">
              <dt>{dict.order.totals.total}</dt>
              <dd>{formatUZS(order.total_uzs, locale)}</dd>
            </div>
          </dl>
        </Card>

        {order.adjustments.length === 0 ? null : (
          <Card title={dict.order.adjust.historyTitle}>
            <ul className="flex flex-col divide-y divide-hairline" data-testid="adjustments">
              {order.adjustments.map((change, index) => (
                <li
                  key={`${change.at}-${String(index)}`}
                  className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0"
                >
                  <p className="font-medium break-words">
                    {locale === 'ru' ? change.name_ru : change.name_uz}:{' '}
                    <span className="tabular">
                      {change.from_quantity} → {change.to_quantity} {dict.units[change.unit]}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground break-words">
                    {dict.order.timeline.reason}: {change.reason}
                    {change.marked_out_of_stock ? ` · ${dict.order.adjust.outOfStockNote}` : ''}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {dict.roles[change.actor_role]} · {formatDateTime(change.at)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title={dict.order.timeline.title}>
          <ol aria-label={dict.order.timeline.title} className="flex flex-col gap-3">
            {order.history_detail.map((change, index) => (
              <li
                key={`${change.at}-${String(index)}`}
                className="flex flex-col gap-0.5 border-l-2 border-hairline pl-3"
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
              [dict.order.createdAt, formatDateTime(order.created_at)],
            ]}
          />
        </Card>
        <Card title={a.title}>
          <Fields rows={addressRows} />
          {yandexUrl === null ? null : (
            <a
              href={yandexUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_BUTTON_PRIMARY}
            >
              {a.callYandex}
            </a>
          )}
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
  const [adjusting, setAdjusting] = useState<{
    line: OrderLine & { product_id: string };
    opener: HTMLElement;
  } | null>(null);
  const [adjustNotice, setAdjustNotice] = useState<string | null>(null);

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
        <h1 className="text-[28px] leading-8 font-bold tracking-[-0.025em] tabular">
          {formatMessage(dict.order.title, { number: order.number })}
        </h1>
        <StatusBadge status={order.status} />
      </div>

      <section
        aria-label={dict.order.actions.title}
        // Phones: the status actions sit in a bar at the bottom, above the tab bar, in thumb
        // reach while the order is read from the top (it comes last in the visual order).
        className="flex flex-col gap-3 rounded-3xl bg-surface p-4 max-sm:sticky max-sm:bottom-[calc(4.25rem+env(safe-area-inset-bottom))] max-sm:z-20 max-sm:order-last max-sm:bg-surface/90 max-sm:p-3 max-sm:shadow-[0_8px_28px_-12px_rgb(20_20_22/0.32)] max-sm:ring-1 max-sm:ring-hairline max-sm:backdrop-blur-xl sm:p-5"
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
              <Button
                key={status}
                onClick={() => void changeStatus(status)}
                disabled={pending}
                className="max-sm:min-h-12 max-sm:flex-1"
              >
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

      {adjustNotice === null ? null : (
        <p
          role="status"
          className="rounded-2xl bg-success-soft px-4 py-3 text-sm font-medium text-success"
        >
          {adjustNotice}
        </p>
      )}

      <OrderBody
        order={order}
        onAdjust={(line, opener) => {
          setAdjustNotice(null);
          setAdjusting({ line, opener });
        }}
      />

      {adjusting === null ? null : (
        <AdjustDialog
          order={order}
          line={adjusting.line}
          returnFocusTo={adjusting.opener}
          onClose={() => setAdjusting(null)}
          onAdjusted={(updated) => {
            setAdjusting(null);
            setLoaded({ key, order: updated, error: null });
            setAdjustNotice(
              updated.status === 'CANCELLED'
                ? dict.order.adjust.cancelledAll
                : dict.order.adjust.done,
            );
          }}
        />
      )}

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
