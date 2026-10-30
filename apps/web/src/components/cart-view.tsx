'use client';

import type { Cart, CartLine } from '@muniramarket/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  ImagePlaceholder,
  QuantityStepper,
  Skeleton,
  formatUZS,
} from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { getCart, removeCartItem, updateCartItem } from '@/lib/api/cart';
import { ApiRequestError } from '@/lib/api/errors';
import { localizedName, maxQuantityFor } from '@/lib/catalog';
import { useSession } from '@/lib/session';
import { SignInPrompt } from './sign-in-prompt';

type Load = { kind: 'loading' } | { kind: 'ready'; cart: Cart } | { kind: 'failed' };

/**
 * The cart page body. Every number comes from the server's `Cart`; nothing is summed or
 * multiplied here. Lines with an `issue` stay visible and are excluded from the totals by the
 * server.
 */
export function CartView() {
  const { dict, locale } = useI18n();
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busyProduct, setBusyProduct] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchCart = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      setLoad({ kind: 'ready', cart: await getCart(apiFetch) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `fetchCart` only sets state asynchronously, after the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchCart();
  }, [status, fetchCart]);

  const mutate = useCallback(
    async (productId: string, action: () => Promise<Cart>) => {
      setBusyProduct(productId);
      setNotice(null);
      try {
        setLoad({ kind: 'ready', cart: await action() });
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'insufficient_stock') {
          setNotice(
            formatMessage(dict.cart.updateInsufficientStock, {
              available: error.availableQuantity ?? 0,
            }),
          );
        } else {
          setNotice(dict.cart.updateFailed);
        }
      } finally {
        setBusyProduct(null);
      }
    },
    [dict],
  );

  if (status !== 'authenticated') {
    return status === 'loading' ? <CartSkeleton label={dict.cart.loading} /> : <SignInPrompt />;
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

  const { cart } = load;
  if (cart.items.length === 0) {
    return (
      <EmptyState
        title={dict.cart.empty}
        description={dict.cart.emptyHint}
        action={
          <Link
            href={`/${locale}`}
            className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            {dict.cart.continueShopping}
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3" aria-label={dict.cart.title}>
        {cart.items.map((line) => (
          <CartLineItem
            key={line.product.id}
            line={line}
            busy={busyProduct === line.product.id}
            onQuantity={(quantity) =>
              mutate(line.product.id, () => updateCartItem(apiFetch, line.product.id, { quantity }))
            }
            onRemove={() =>
              mutate(line.product.id, () => removeCartItem(apiFetch, line.product.id))
            }
          />
        ))}
      </ul>

      <div aria-live="polite">
        {notice !== null ? (
          <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
            {notice}
          </p>
        ) : null}
        {cart.has_issues ? (
          <p className="text-sm text-muted-foreground">{dict.cart.issuesNote}</p>
        ) : null}
      </div>

      <section
        aria-label={dict.cart.total}
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
      >
        <p className="flex justify-between text-muted-foreground">
          <span>{formatMessage(dict.cart.itemCount, { count: cart.item_count })}</span>
        </p>
        <p className="flex justify-between">
          <span>{dict.cart.subtotal}</span>
          <span data-testid="cart-subtotal">{formatUZS(cart.subtotal_uzs, locale)}</span>
        </p>
        <p className="flex justify-between text-lg font-bold">
          <span>{dict.cart.total}</span>
          <span data-testid="cart-total">{formatUZS(cart.total_uzs, locale)}</span>
        </p>
        <p className="text-sm text-muted-foreground" data-testid="checkout-soon">
          {dict.cart.checkoutSoon}
        </p>
      </section>
    </div>
  );
}

function CartSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-28 w-full" />
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
      className="flex gap-3 rounded-xl border border-border bg-surface p-3"
    >
      <ImagePlaceholder src={product.image_url} alt={name} className="w-20 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Link
          href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
          className="line-clamp-2 font-medium hover:underline"
        >
          {name}
        </Link>
        <p className="text-sm text-muted-foreground">
          {formatUZS(product.price_uzs, locale)} / {dict.units[product.unit]}
        </p>

        {issueText !== null ? (
          <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
            {issueText}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <QuantityStepper
            value={line.quantity}
            min={1}
            max={Math.max(line.quantity, maxQuantityFor(product))}
            disabled={busy}
            onChange={onQuantity}
            label={`${dict.product.quantity}: ${name}`}
            decreaseLabel={dict.product.decrease}
            increaseLabel={dict.product.increase}
          />
          {hasIssue ? null : (
            <span className="font-semibold" data-testid="line-total">
              {formatUZS(line.line_total_uzs, locale)}
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={onRemove}
          aria-label={`${dict.cart.remove}: ${name}`}
          className="self-start text-sm"
        >
          {dict.cart.remove}
        </Button>
      </div>
    </li>
  );
}
