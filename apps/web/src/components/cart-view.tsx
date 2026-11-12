'use client';

import type { Cart, CartLine } from '@muniramarket/contracts';
import type { DeliveryZone } from '@muniramarket/contracts';
import { Button, ErrorState, QuantityStepper, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { getCart, removeCartItem, updateCartItem } from '@/lib/api/cart';
import { getDeliveryZones } from '@/lib/api/delivery';
import { ApiRequestError } from '@/lib/api/errors';
import { useCartSettled, useCartSync } from '@/lib/cart';
import { localizedName, maxQuantityFor } from '@/lib/catalog';
import { retryAfterSeconds } from '@/lib/checkout/failures';
import { zoneForDistrict } from '@/lib/checkout/zones';
import { useDistrictPreference } from '@/lib/delivery/district-preference';
import { useSession } from '@/lib/session';
import { useMainButton } from '@/lib/telegram';
import { useCooldown } from '@/lib/use-cooldown';
import { EmptyPanel } from './empty-panel';
import { FreeDeliveryProgress } from './free-delivery-progress';
import { BagIcon, TrashIcon } from './icons';
import { ProductImage } from './product-image';
import { SignInPrompt } from './sign-in-prompt';
import { FOCUS_RING, GROUP, LINK_BUTTON_PRIMARY, PRESS, ROWS } from './ui-classes';

/** A note under the lines: a message, or "wait a moment" (shown only for as long as the wait lasts). */
type Notice = { kind: 'text'; text: string } | { kind: 'rate_limited' };

type Load = { kind: 'loading' } | { kind: 'ready'; cart: Cart } | { kind: 'failed' };

/**
 * The cart page body. Every number comes from the server's `Cart`; nothing is summed or
 * multiplied here. Lines with an `issue` stay visible and are excluded from the totals by the
 * server.
 */
export function CartView() {
  const { dict, locale } = useI18n();
  const { status, apiFetch, retry } = useSession();
  const router = useRouter();
  const syncCart = useCartSync();
  const cartSettled = useCartSettled();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Free-delivery progress: only for a district the customer already chose, and only when that
  // district's zone really has a threshold. A failed lookup just hides the bar.
  const [district] = useDistrictPreference();
  const [zones, setZones] = useState<DeliveryZone[] | null>(null);
  const [busyProduct, setBusyProduct] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A 429 on a quantity change or a removal: every line is locked until `Retry-After` has passed.
  const { seconds: waitSeconds, start: startCooldown } = useCooldown();
  const waiting = waitSeconds > 0;
  const noticeText =
    notice === null
      ? null
      : notice.kind === 'text'
        ? notice.text
        : waiting
          ? dict.cart.updateRateLimited
          : null;

  const fetchCart = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      // Changes tapped on the product cards just before opening the cart may still be in flight.
      await cartSettled();
      const loaded = await getCart(apiFetch);
      syncCart(loaded);
      setLoad({ kind: 'ready', cart: loaded });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry, syncCart, cartSettled]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `fetchCart` only sets state asynchronously, after the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchCart();
  }, [status, fetchCart]);

  useEffect(() => {
    if (status !== 'authenticated' || district === null) return;
    let live = true;
    getDeliveryZones(apiFetch)
      .then((list) => {
        if (live) setZones(list.items);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [status, district, apiFetch]);

  const mutate = useCallback(
    async (productId: string, action: () => Promise<Cart>) => {
      setBusyProduct(productId);
      setNotice(null);
      try {
        const updated = await action();
        syncCart(updated);
        setLoad({ kind: 'ready', cart: updated });
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'rate_limited') {
          startCooldown(retryAfterSeconds(error.retryAfter));
          setNotice({ kind: 'rate_limited' });
        } else if (error instanceof ApiRequestError && error.code === 'insufficient_stock') {
          setNotice({
            kind: 'text',
            text: formatMessage(dict.cart.updateInsufficientStock, {
              available: error.availableQuantity ?? 0,
            }),
          });
        } else {
          setNotice({ kind: 'text', text: dict.cart.updateFailed });
        }
      } finally {
        setBusyProduct(null);
      }
    },
    [dict, startCooldown, syncCart],
  );

  // Telegram: the native MainButton opens the checkout. Only offered for a cart that can be
  // checked out; it is hidden for an empty cart or one with problem lines (the in-page note says
  // what to fix) and released when this page unmounts. No-op in a browser.
  const checkoutHref = `/${locale}/checkout`;
  const cart = load.kind === 'ready' ? load.cart : null;
  const canCheckout = cart !== null && cart.items.length > 0 && !cart.has_issues;
  useMainButton(
    canCheckout
      ? {
          text: `${dict.cart.checkout} — ${formatUZS(cart.total_uzs, locale)}`,
          onClick: () => router.push(checkoutHref),
        }
      : null,
  );

  if (status !== 'authenticated') {
    return status === 'loading' ? (
      <CartSkeleton label={dict.cart.loading} />
    ) : (
      <SignInPrompt variant="screen" />
    );
  }
  if (load.kind === 'loading') return <CartSkeleton label={dict.cart.loading} />;
  if (load.kind === 'failed') {
    return (
      <ErrorState
        title={dict.cart.loadFailed}
        retryLabel={dict.cart.retry}
        onRetry={() => void fetchCart()}
      />
    );
  }

  if (cart === null) return null;
  if (cart.items.length === 0) {
    return (
      <EmptyPanel
        icon={<BagIcon />}
        title={dict.cart.empty}
        description={dict.cart.emptyHint}
        action={
          <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
            {dict.cart.continueShopping}
          </Link>
        }
      />
    );
  }

  const zone = district === null || zones === null ? null : zoneForDistrict(zones, district);
  const threshold = zone?.free_delivery_threshold_uzs ?? null;

  return (
    <div className="flex flex-col gap-3">
      {threshold !== null && threshold > 0 && !cart.has_issues ? (
        <div className={`${GROUP} p-4`}>
          <FreeDeliveryProgress
            threshold={threshold}
            remaining={Math.max(0, threshold - cart.subtotal_uzs)}
            testId="cart-free-delivery"
          />
        </div>
      ) : null}

      <ul className={`${GROUP} ${ROWS} flex flex-col px-4`} aria-label={dict.cart.title}>
        {cart.items.map((line) => (
          <CartLineItem
            key={line.product.id}
            line={line}
            busy={busyProduct === line.product.id || waiting}
            onQuantity={(quantity) =>
              mutate(line.product.id, () => updateCartItem(apiFetch, line.product.id, { quantity }))
            }
            onRemove={() =>
              mutate(line.product.id, () => removeCartItem(apiFetch, line.product.id))
            }
          />
        ))}
      </ul>

      <div aria-live="polite" className="empty:hidden">
        {noticeText !== null ? (
          <p role="alert" className="px-1 text-sm font-medium text-danger">
            {noticeText}
          </p>
        ) : null}
        {cart.has_issues ? (
          <p className="px-1 text-sm text-muted-foreground">{dict.cart.issuesNote}</p>
        ) : null}
      </div>

      <section aria-label={dict.cart.total} className={`${GROUP} flex flex-col gap-2 p-4`}>
        <p className="flex justify-between gap-3 text-muted-foreground">
          <span>{formatMessage(dict.cart.itemCount, { count: cart.item_count })}</span>
          <span data-money data-testid="cart-subtotal">
            {formatUZS(cart.subtotal_uzs, locale)}
          </span>
        </p>
        <p className="flex items-baseline justify-between gap-3 text-xl font-bold tracking-[-0.01em]">
          <span>{dict.cart.total}</span>
          <span data-money data-testid="cart-total">
            {formatUZS(cart.total_uzs, locale)}
          </span>
        </p>
        <p className="text-sm text-muted-foreground">{dict.cart.deliveryAtCheckout}</p>
        {canCheckout ? (
          <Link
            href={checkoutHref}
            className={`${LINK_BUTTON_PRIMARY} mt-2`}
            data-testid="checkout-link"
          >
            {dict.cart.checkout}
          </Link>
        ) : (
          <Button
            size="lg"
            disabled
            className="mt-2 min-h-13 rounded-2xl"
            data-testid="checkout-link"
          >
            {dict.cart.checkout}
          </Button>
        )}
      </section>
    </div>
  );
}

function CartSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <div className={`${GROUP} flex flex-col gap-4 p-4`}>
        {[0, 1].map((index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="size-[72px] shrink-0 rounded-2xl" />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="mt-1 h-11 w-32 rounded-full" />
            </div>
          </div>
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-3xl bg-surface" />
    </div>
  );
}

interface CartLineItemProps {
  line: CartLine;
  busy: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}

function CartLineItem({ line, busy, onQuantity, onRemove }: CartLineItemProps) {
  const { dict, locale } = useI18n();
  const { product } = line;
  const name = localizedName(product, locale);
  const hasIssue = line.issue !== null;
  const issueText =
    line.issue === 'product_inactive'
      ? dict.cart.issueInactive
      : line.issue === 'insufficient_stock'
        ? formatMessage(dict.cart.issueInsufficientStock, {
            available: product.stock_quantity ?? 0,
          })
        : null;

  return (
    <li
      data-testid="cart-line"
      data-issue={line.issue ?? undefined}
      className="flex gap-3 py-3.5"
    >
      <Link
        href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
        tabIndex={-1}
        aria-hidden="true"
        className="shrink-0 self-start"
      >
        <ProductImage
          src={product.image_url}
          name={name}
          toneKey={product.category_id}
          className={`w-[72px] rounded-2xl ${hasIssue ? 'opacity-50 grayscale' : ''}`}
        />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <Link
            href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
            data-user-text
            className={`line-clamp-2 min-w-0 flex-1 rounded-md leading-5 font-medium hover:underline ${FOCUS_RING}`}
          >
            {name}
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            aria-label={`${dict.cart.remove}: ${name}`}
            className={`-mt-2.5 -mr-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 ${PRESS} ${FOCUS_RING}`}
          >
            <TrashIcon width={19} height={19} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          <span data-money>{formatUZS(product.price_uzs, locale)}</span> / {dict.units[product.unit]}
        </p>

        {issueText !== null ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {issueText}
          </p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <QuantityStepper
            value={line.quantity}
            min={1}
            max={Math.max(line.quantity, maxQuantityFor(product))}
            disabled={busy}
            onChange={onQuantity}
            label={`${dict.product.quantity}: ${name}`}
            decreaseLabel={dict.product.decrease}
            increaseLabel={dict.product.increase}
            className="h-11 rounded-full border-0 bg-surface-muted [&_button]:rounded-full [&_button]:text-lg"
          />
          {hasIssue ? null : (
            <span data-money className="text-[17px] font-bold" data-testid="line-total">
              {formatUZS(line.line_total_uzs, locale)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
