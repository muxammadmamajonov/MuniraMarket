'use client';

import { formatUZS, Button } from '@muniramarket/ui';
import Link from 'next/link';
import { forwardRef } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { isRetrySafe, type CheckoutFailure } from '@/lib/checkout/failures';
import type { PriceChange } from '@/lib/checkout/use-checkout';
import { ERROR_TEXT, LINK_BUTTON_SECONDARY } from '../ui-classes';

export interface FailureNoticeProps {
  failure: CheckoutFailure | null;
  priceChange: PriceChange | null;
  /** Seconds left of a rate-limit wait; 0 when it is over. */
  cooldown: number;
  busy: boolean;
  /** Retry the identical request (same idempotency key). */
  onRetry: () => void;
  /** Confirm the new total after a price change. */
  onConfirmPrice: () => void;
}

/**
 * Everything that can go wrong when placing the order, in one live region that the page scrolls
 * to. Messages say what happened, that entered data is kept, and what to do next.
 */
export const FailureNotice = forwardRef<HTMLDivElement, FailureNoticeProps>(function FailureNotice(
  { failure, priceChange, cooldown, busy, onRetry, onConfirmPrice },
  ref,
) {
  const { dict, locale } = useI18n();
  const f = dict.checkout.failures;

  let message: string | null = null;
  let toCart = false;
  let toOrders = false;
  if (failure !== null) {
    switch (failure.kind) {
      case 'price_changed':
        message = null; // shown by the price-change block below
        break;
      case 'insufficient_stock':
        message =
          failure.available === null
            ? f.insufficientStockUnknown
            : formatMessage(f.insufficientStock, { available: failure.available });
        toCart = true;
        break;
      case 'product_inactive':
        message = f.productInactive;
        toCart = true;
        break;
      case 'cart_empty':
        message = f.cartEmpty;
        toCart = true;
        break;
      case 'below_min_order':
        message = f.belowMin;
        toCart = true;
        break;
      case 'district_not_served':
        message = f.districtNotServed;
        break;
      case 'too_many_open_orders':
        message = f.tooManyOpenOrders;
        toOrders = true;
        break;
      case 'validation':
        message = failure.unmapped > 0 ? f.unmapped : dict.checkout.errors.formInvalid;
        break;
      case 'rate_limited':
        message = formatMessage(f.rateLimited, { seconds: Math.max(cooldown, 0) });
        break;
      case 'session':
        message = f.session;
        break;
      case 'blocked':
        message = f.blocked;
        break;
      case 'network':
        message = f.network;
        break;
      case 'server':
        message = f.server;
        break;
      case 'key_conflict':
        message = f.keyConflict;
        break;
    }
  }

  const canRetry = failure !== null && isRetrySafe(failure);
  const waiting = failure?.kind === 'rate_limited' && cooldown > 0;

  return (
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-3 outline-none" aria-live="polite">
      {priceChange === null ? null : (
        <div
          role="alert"
          data-testid="price-changed"
          className="mm-enter flex flex-col gap-3 rounded-xl border border-amber-600 bg-amber-50 p-4 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-bold">{f.priceChangedTitle}</p>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
            <dt>{f.priceWas}</dt>
            <dd data-money data-testid="price-was" className="justify-self-end line-through">
              {formatUZS(priceChange.from, locale)}
            </dd>
            <dt className="font-bold">{f.priceNow}</dt>
            <dd data-money data-testid="price-now" className="justify-self-end text-lg font-bold">
              {formatUZS(priceChange.to, locale)}
            </dd>
          </dl>
          <Button disabled={busy} onClick={onConfirmPrice}>
            {dict.checkout.confirmNewTotal}
          </Button>
        </div>
      )}

      {message === null ? null : (
        <div
          role="alert"
          data-testid="submit-failure"
          data-failure={failure?.kind}
          className="mm-enter flex flex-col items-start gap-3"
        >
          <p className={ERROR_TEXT}>{message}</p>
          {canRetry ? (
            <Button variant="secondary" disabled={busy || waiting} onClick={onRetry}>
              {f.retry}
            </Button>
          ) : null}
          {toOrders ? (
            <Link href={`/${locale}/orders`} className={LINK_BUTTON_SECONDARY}>
              {f.goToOrders}
            </Link>
          ) : null}
          {toCart ? (
            <Link href={`/${locale}/cart`} className={LINK_BUTTON_SECONDARY}>
              {f.goToCart}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
});
