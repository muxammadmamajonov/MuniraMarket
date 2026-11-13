'use client';

import type { AdminOrderDetail, OrderItemAdjustRequest } from '@muniramarket/contracts';
import { Button, cx } from '@muniramarket/ui';
import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { readErrorMessage } from '@/lib/api/error-messages';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { CHIP, CHIP_OFF, CHIP_ON, INPUT, TEXTAREA } from './ui/classes';
import { Modal } from './ui/modal';

export type OrderLine = AdminOrderDetail['items'][number];

const REASON_MIN = 3;
const REASON_MAX = 300;

/**
 * "Not enough of this product" while picking (ADR 0018): the operator enters how much the shop
 * really has (0 = none), picks or types a reason, and decides whether the product is now out of
 * stock everywhere. `PATCH /admin/orders/{id}/items/{product_id}` recomputes the totals, notifies
 * the customer and returns the updated order; when every line reaches 0 the API cancels it.
 */
export function AdjustDialog({
  order,
  line,
  returnFocusTo,
  onClose,
  onAdjusted,
}: {
  order: AdminOrderDetail;
  line: OrderLine & { product_id: string };
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
  onAdjusted: (order: AdminOrderDetail) => void;
}) {
  const { dict, locale } = useI18n();
  const { apiFetch } = useSession();
  const copy = dict.order.adjust;
  const quantityId = useId();
  const reasonId = useId();
  const unit = dict.units[line.unit];

  const [quantity, setQuantity] = useState('0');
  const [reason, setReason] = useState(copy.reasons[0] ?? '');
  const [markOut, setMarkOut] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const parsed = /^\d{1,3}$/.test(quantity.trim()) ? Number(quantity.trim()) : NaN;
  const quantityOk = Number.isInteger(parsed) && parsed >= 0 && parsed < line.quantity;
  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!quantityOk || !reasonOk || pending) return;
    setPending(true);
    setError(null);
    try {
      const body: OrderItemAdjustRequest = {
        quantity: parsed,
        reason: reason.trim(),
        mark_out_of_stock: markOut,
      };
      const response = await apiFetch(
        `/admin/orders/${encodeURIComponent(order.id)}/items/${encodeURIComponent(line.product_id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) {
        onAdjusted(await readJson<AdminOrderDetail>(response));
        return;
      }
      const failure = await ApiRequestError.fromResponse(response);
      setError(
        failure.code === 'order_not_adjustable'
          ? copy.errors.notAdjustable
          : failure.code === 'invalid_quantity'
            ? copy.errors.invalidQuantity
            : failure.code === 'forbidden' || failure.code === 'rate_limited'
              ? readErrorMessage(dict, failure)
              : copy.errors.failed,
      );
    } catch {
      setError(copy.errors.failed);
    } finally {
      setPending(false);
    }
  };

  const name = locale === 'ru' ? line.name_ru : line.name_uz;

  return (
    <Modal
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={returnFocusTo}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <p className="rounded-2xl bg-surface-muted px-4 py-3 font-semibold break-words">
          {name}
          <span className="block text-sm font-normal text-muted-foreground">
            {line.quantity} {unit}
          </span>
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={quantityId} className="text-sm font-medium">
            {copy.quantityLabel} ({unit})
          </label>
          <input
            id={quantityId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            aria-invalid={touched && !quantityOk}
            data-testid="adjust-quantity"
            className={INPUT}
          />
          <p className="text-sm text-muted-foreground">
            {formatMessage(copy.quantityHint, { quantity: `${String(line.quantity)} ${unit}` })}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={reasonId} className="text-sm font-medium">
            {copy.reasonLabel}
          </label>
          {/* `mm-in-sheet`: unselected chips take the filled look on the white panel. */}
          <ul className="mm-in-sheet flex flex-wrap gap-2">
            {copy.reasons.map((choice) => (
              <li key={choice}>
                <button
                  type="button"
                  onClick={() => setReason(choice)}
                  aria-pressed={reason === choice}
                  className={cx(CHIP, reason === choice ? CHIP_ON : CHIP_OFF)}
                >
                  {choice}
                </button>
              </li>
            ))}
          </ul>
          <textarea
            id={reasonId}
            value={reason}
            maxLength={REASON_MAX}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={touched && !reasonOk}
            data-testid="adjust-reason"
            className={TEXTAREA}
          />
          {touched && !reasonOk ? (
            <p role="alert" className="text-sm text-danger">
              {copy.reasonInvalid}
            </p>
          ) : null}
        </div>

        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={markOut}
            onChange={(event) => setMarkOut(event.target.checked)}
            data-testid="adjust-mark-out"
            className="mt-0.5 size-5 shrink-0 accent-(--mm-color-primary)"
          />
          <span>
            <span className="block font-medium">{copy.markOutOfStock}</span>
            <span className="block text-sm text-muted-foreground">{copy.markOutOfStockHint}</span>
          </span>
        </label>

        {error === null ? null : (
          <p
            role="alert"
            className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
          >
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {copy.dismiss}
          </Button>
          <Button type="submit" disabled={pending} data-testid="adjust-confirm">
            {copy.confirm}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
