'use client';

import type { ProductSummary } from '@muniramarket/contracts';
import { Button, QuantityStepper, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { addCartItem } from '@/lib/api/cart';
import { ApiRequestError } from '@/lib/api/errors';
import { MAX_LINE_QUANTITY, maxQuantityFor } from '@/lib/catalog';
import { retryAfterSeconds } from '@/lib/checkout/failures';
import { useSession } from '@/lib/session';
import { useHaptics, useMainButton } from '@/lib/telegram';
import { useCooldown } from '@/lib/use-cooldown';
import { SignInPrompt } from './sign-in-prompt';

type Phase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'added' }
  /** The API asked us to wait (429); shown, and the button disabled, until the wait is over. */
  | { kind: 'rate_limited' }
  | { kind: 'error'; message: string };

export interface AddToCartProps {
  product: Pick<ProductSummary, 'id' | 'price_uzs' | 'in_stock' | 'stock_quantity'>;
}

/**
 * Quantity stepper and "Add to cart" button. Inside Telegram the same action is also offered on
 * the native MainButton ("Add to cart — <price>"), which adds the current stepper quantity.
 */
export function AddToCart({ product }: AddToCartProps) {
  const { dict, locale } = useI18n();
  const session = useSession();
  const haptics = useHaptics();
  const max = maxQuantityFor(product);
  const [requested, setRequested] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const { seconds: waitSeconds, start: startCooldown } = useCooldown();

  const quantity = Math.min(requested, max);
  const authenticated = session.status === 'authenticated';
  const pending = phase.kind === 'pending';
  const waiting = waitSeconds > 0;
  const canAdd = product.in_stock && authenticated && !pending && !waiting;
  const { apiFetch, retry } = session;

  const add = useCallback(async () => {
    setPhase({ kind: 'pending' });
    try {
      await addCartItem(apiFetch, { product_id: product.id, quantity });
      setPhase({ kind: 'added' });
      haptics.notify('success');
    } catch (error) {
      haptics.notify('error');
      if (error instanceof ApiRequestError && error.code === 'rate_limited') {
        startCooldown(retryAfterSeconds(error.retryAfter));
        setPhase({ kind: 'rate_limited' });
        return;
      }
      setPhase({ kind: 'error', message: addErrorMessage(error, dict, retry) });
    }
  }, [apiFetch, retry, product.id, quantity, haptics, dict, startCooldown]);

  const priceText = formatUZS(product.price_uzs, locale);
  useMainButton(
    product.in_stock && authenticated
      ? {
          text: `${dict.product.addToCart} — ${priceText}`,
          onClick: () => {
            if (canAdd) void add();
          },
          loading: pending,
          disabled: pending || waiting,
        }
      : null,
  );

  if (!product.in_stock) return null;

  return (
    <div className="flex flex-col gap-3">
      {session.status === 'anonymous' || session.status === 'error' ? <SignInPrompt /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <QuantityStepper
          value={quantity}
          min={1}
          max={max}
          onChange={(next) => {
            setRequested(next);
            if (phase.kind !== 'pending') setPhase({ kind: 'idle' });
          }}
          label={dict.product.quantity}
          decreaseLabel={dict.product.decrease}
          increaseLabel={dict.product.increase}
        />
        <Button size="lg" disabled={!canAdd} onClick={() => void add()} className="flex-1">
          {pending ? dict.product.adding : dict.product.addToCart}
        </Button>
      </div>

      {max < MAX_LINE_QUANTITY && product.stock_quantity !== null ? (
        <p className="text-sm text-muted-foreground">
          {formatMessage(dict.product.maxPerOrder, { count: max })}
        </p>
      ) : null}

      <div aria-live="polite" className="min-h-6">
        {phase.kind === 'added' ? (
          <p className="flex flex-wrap items-center gap-2 font-medium" data-testid="added-message">
            <span>{dict.product.added}</span>
            <Link href={`/${locale}/cart`} className="underline underline-offset-2">
              {dict.product.viewCart}
            </Link>
          </p>
        ) : null}
        {phase.kind === 'rate_limited' && waiting ? (
          <p
            role="alert"
            data-testid="rate-limited"
            className="text-sm font-medium text-red-600 dark:text-red-400"
          >
            {dict.product.errors.rateLimited}
          </p>
        ) : null}
        {phase.kind === 'error' ? (
          <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
            {phase.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function addErrorMessage(
  error: unknown,
  dict: ReturnType<typeof useI18n>['dict'],
  retrySession: () => void,
): string {
  if (!(error instanceof ApiRequestError)) return dict.product.errors.generic;
  switch (error.code) {
    case 'insufficient_stock':
      return formatMessage(dict.product.errors.insufficientStock, {
        available: error.availableQuantity ?? 0,
      });
    case 'product_inactive':
    case 'product_not_found':
      return dict.product.errors.productInactive;
    case 'cart_limit_reached':
      return dict.product.errors.cartLimit;
    case 'session_required':
      // The session expired underneath us; re-establish it so the sign-in prompt can take over.
      retrySession();
      return dict.product.errors.generic;
    default:
      return dict.product.errors.generic;
  }
}
