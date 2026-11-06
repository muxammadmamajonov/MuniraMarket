'use client';

import type { ProductSummary } from '@muniramarket/contracts';
import { MoneyText, Price, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useCart } from '@/lib/cart';
import {
  localizedName,
  maxQuantityFor,
  previousPrice,
  stockLabel,
  stockState,
} from '@/lib/catalog';
import { useSession } from '@/lib/session';
import { useHaptics } from '@/lib/telegram';
import { MinusIcon, PlusIcon } from './icons';
import { ProductImage } from './product-image';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface ProductTileProps {
  product: ProductSummary;
}

/**
 * Grid card: image (or tinted monogram), two-line name, price with unit, and the cart control.
 * The control is a sibling of the product link, never inside it. It is "Savatga" until the
 * product is in the cart, then a - qty + stepper (a filled pill, so "in cart" reads at a glance);
 * going down from 1 removes the line. Quantities come from the shared cart, never computed here.
 */
export function ProductTile({ product }: ProductTileProps) {
  const { dict, locale } = useI18n();
  const session = useSession();
  const cart = useCart();
  const haptics = useHaptics();
  // The add / stepper swap animates only after the customer has tapped, never when a page of
  // cards (or the cart behind them) first appears.
  const [interacted, setInteracted] = useState(false);
  const pop = interacted ? 'mm-pop ' : '';

  const name = localizedName(product, locale);
  const state = stockState(product);
  const old = previousPrice(product);
  const max = maxQuantityFor(product);
  const quantity = cart.quantityOf(product.id);
  const error = cart.errorFor(product.id);
  const usable = session.status === 'authenticated' && !cart.waiting;

  const change = (next: number) => {
    setInteracted(true);
    haptics.impact('light');
    cart.setQuantity(product, next);
  };

  return (
    <article
      data-testid="product-tile"
      data-stock={state.kind}
      className="flex w-full flex-col rounded-2xl border border-border bg-surface"
    >
      <Link
        href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
        prefetch={false}
        className={`flex flex-col gap-2 rounded-2xl p-2 pb-1 ${FOCUS_RING}`}
      >
        <div className={state.kind === 'out' ? 'opacity-55' : undefined}>
          <ProductImage
            src={product.image_url}
            name={name}
            toneKey={product.category_id}
            className="rounded-xl"
          />
        </div>
        <span data-user-text className="line-clamp-2 min-h-10 text-sm leading-5 font-medium">
          {name}
        </span>
        {/* Price first and largest, the unit right after it, an old price (only when the data
            really has a higher one) quieter underneath. */}
        <span className="flex flex-col gap-0.5">
          <span data-testid="tile-price" className="flex flex-wrap items-baseline gap-x-1">
            <Price
              amount={product.price_uzs}
              locale={locale}
              {...(old === null ? {} : { currentLabel: dict.product.priceCurrentLabel })}
              data-money
              className="text-base leading-6 tabular-nums"
            />
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              / {dict.units[product.unit]}
            </span>
          </span>
          {old === null ? null : (
            <del data-money className="text-xs leading-4 text-muted-foreground tabular-nums">
              <span className="sr-only">{dict.product.priceOldLabel} </span>
              <MoneyText text={formatUZS(old, locale)} />
            </del>
          )}
          {state.kind === 'low' ? (
            <span className="text-xs font-medium text-warning">{stockLabel(state, dict)}</span>
          ) : null}
        </span>
      </Link>

      <div className="mt-auto px-2 pt-1 pb-2">
        {state.kind === 'out' ? (
          <button
            type="button"
            disabled
            aria-label={`${dict.product.outOfStock}: ${name}`}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-surface-muted px-2 text-sm font-semibold text-muted-foreground"
          >
            {dict.product.outOfStock}
          </button>
        ) : quantity === 0 ? (
          <button
            type="button"
            disabled={!usable}
            onClick={() => change(1)}
            aria-label={`${dict.product.addToCart}: ${name}`}
            className={`${pop}inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-2 text-sm font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
          >
            <PlusIcon width={18} height={18} />
            {dict.product.addShort}
          </button>
        ) : (
          <div
            role="group"
            aria-label={`${dict.product.quantity}: ${name}`}
            className={`${pop}flex h-11 w-full items-center justify-between rounded-xl bg-primary text-primary-foreground`}
          >
            <button
              type="button"
              disabled={!usable}
              onClick={() => change(quantity - 1)}
              aria-label={`${quantity <= 1 ? dict.cart.remove : dict.product.decrease}: ${name}`}
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
            >
              <MinusIcon width={20} height={20} />
            </button>
            <output
              aria-live="polite"
              className="min-w-0 px-1 text-base font-semibold tabular-nums"
            >
              {quantity}
            </output>
            <button
              type="button"
              disabled={!usable || quantity >= max}
              onClick={() => change(quantity + 1)}
              aria-label={`${dict.product.increase}: ${name}`}
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
            >
              <PlusIcon width={20} height={20} />
            </button>
          </div>
        )}
        {error === null ? null : (
          <p role="alert" className="pt-1.5 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
