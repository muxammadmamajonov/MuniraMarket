'use client';

import type { OrderDetail, OrderStatus } from '@muniramarket/contracts';
import { Button } from '@muniramarket/ui';
import { useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { ApiRequestError } from '@/lib/api/errors';
import { cancelOrder } from '@/lib/api/orders';
import { charCount, clampChars } from '@/lib/checkout/form';
import { useSession } from '@/lib/session';
import { useHaptics } from '@/lib/telegram';
import { BottomSheet } from '../bottom-sheet';
import { ERROR_TEXT, INPUT, PRESS, FOCUS_RING } from '../ui-classes';

/** Server limits for the cancellation reason. */
export const REASON_MIN = 3;
export const REASON_MAX = 300;

export interface CancelOrderSheetProps {
  open: boolean;
  orderId: string;
  onClose: () => void;
  /** The order as the server returned it after the cancellation. */
  onCancelled: (order: OrderDetail) => void;
  /** The order changed under us (409); the parent should reload it. */
  onStale: () => void;
}

type Problem =
  | { kind: 'network' }
  | { kind: 'generic' }
  | { kind: 'not_cancellable'; status: OrderStatus | null };

/**
 * Confirmation sheet for cancelling an order: a required free-text reason (3-300 characters) with
 * a few localized quick picks that fill the textarea.
 */
export function CancelOrderSheet({
  open,
  orderId,
  onClose,
  onCancelled,
  onStale,
}: CancelOrderSheetProps) {
  const { dict } = useI18n();
  const { apiFetch, retry } = useSession();
  const { notify } = useHaptics();
  const t = dict.orders.cancel;
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const locked = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = reason.trim();
  const length = charCount(trimmed);
  const valid = length >= REASON_MIN && length <= REASON_MAX;
  // An empty field is only reported once the customer tries to cancel; a too-short text is
  // reported as soon as the field was left. The error row below has reserved height either way.
  const tooShort = length < REASON_MIN && (attempted || (touched && length > 0));

  const quick = [
    t.quickReasons.changedMind,
    t.quickReasons.wrongOrder,
    t.quickReasons.wrongAddress,
    t.quickReasons.foundElsewhere,
  ];

  const submit = async () => {
    setAttempted(true);
    if (!valid) {
      textareaRef.current?.focus();
      return;
    }
    if (locked.current) return;
    locked.current = true;
    setSubmitting(true);
    setProblem(null);
    try {
      const order = await cancelOrder(apiFetch, orderId, trimmed);
      notify('success');
      setReason('');
      setTouched(false);
      setAttempted(false);
      onCancelled(order);
    } catch (error) {
      notify('error');
      if (error instanceof ApiRequestError && error.code === 'order_not_cancellable') {
        setProblem({ kind: 'not_cancellable', status: error.currentStatus });
        onStale();
      } else if (error instanceof ApiRequestError && error.code === 'session_required') {
        retry();
        setProblem({ kind: 'generic' });
      } else if (error instanceof ApiRequestError && error.isNetworkError) {
        setProblem({ kind: 'network' });
      } else {
        setProblem({ kind: 'generic' });
      }
    } finally {
      locked.current = false;
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t.title}
      description={t.description}
      closeLabel={t.close}
      dismissible={!submitting}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <p id="cancel-quick-label" className="text-sm font-medium">
            {t.quickLabel}
          </p>
          <div role="group" aria-labelledby="cancel-quick-label" className="flex flex-wrap gap-2">
            {quick.map((text) => (
              <button
                key={text}
                type="button"
                disabled={submitting}
                onClick={() => {
                  setReason(clampChars(text, REASON_MAX));
                  setTouched(true);
                }}
                className={`min-h-11 rounded-full border border-border bg-surface px-4 text-left text-sm font-medium hover:bg-surface-muted disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="cancel-reason" className="text-sm font-medium">
              {t.reasonLabel}
            </label>
            <span data-money aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">
              {formatMessage(t.counter, { count: charCount(reason), max: REASON_MAX })}
            </span>
          </div>
          <textarea
            ref={textareaRef}
            id="cancel-reason"
            name="reason"
            data-autofocus=""
            data-user-text=""
            rows={3}
            maxLength={REASON_MAX}
            autoComplete="off"
            autoCapitalize="sentences"
            required
            disabled={submitting}
            aria-invalid={tooShort ? true : undefined}
            aria-describedby={tooShort ? 'cancel-reason-error' : undefined}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            className={`${INPUT} resize-none`}
          />
          {/* Reserved height: this sheet is anchored to the bottom edge, so a row appearing here
              would push the chips above it up between a tap's press and release. */}
          <div className="min-h-5" aria-live="polite">
            {tooShort ? (
              <p id="cancel-reason-error" role="alert" className={ERROR_TEXT}>
                {formatMessage(t.tooShort, { min: REASON_MIN })}
              </p>
            ) : null}
          </div>
        </div>

        <div aria-live="polite">
          {problem === null ? null : (
            <p role="alert" data-testid="cancel-problem" className={ERROR_TEXT}>
              {problem.kind === 'network'
                ? t.network
                : problem.kind === 'not_cancellable'
                  ? problem.status === null
                    ? t.notCancellable
                    : formatMessage(t.notCancellableNow, {
                        status: dict.orders.status[problem.status],
                      })
                  : t.generic}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="submit"
            size="lg"
            disabled={submitting}
            aria-busy={submitting}
            className="bg-red-700 text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500 sm:flex-1"
          >
            {submitting ? t.cancelling : t.confirm}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            disabled={submitting}
            onClick={onClose}
            className="sm:flex-1"
          >
            {t.keep}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
