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
import { PHOTO_SIZES } from '@/lib/photo';
import { ProductImage } from './product-image';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface ProductTileProps {
  product: ProductSummary;
}

/**
 * Grid card in the large-grocery pattern: the photo (or tinted monogram) carries the card, the
 * price comes first and largest under it, then the two-line name. No border or box: the image
 * tile is the shape. The cart control sits on the photo's bottom-right corner: a round "+" until
 * the product is in the cart, then a red - qty + pill across the photo (going down from 1
 * removes the line). It is a sibling of the product link, never inside it. Quantities come from
 * the shared cart, never computed here.
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
      className="relative flex w-full min-w-0 flex-col"
    >
      <Link
        href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
        prefetch={false}
        className={`group flex flex-col gap-1.5 rounded-2xl ${FOCUS_RING}`}
      >
        <div
          className={`transition-[opacity,filter] duration-150 ${state.kind === 'out' ? 'opacity-50 grayscale' : ''}`}
        >
          <ProductImage
            src={product.image_url}
            name={name}
            toneKey={product.category_id}
            sizes={PHOTO_SIZES.tile}
            className="rounded-2xl"
          />
        </div>
        {/* Price first and largest, the unit right after it, an old price (only when the data
            really has a higher one) next to it in red-free muted text. */}
        <span className="flex flex-col gap-0.5 px-0.5">
          <span data-testid="tile-price" className="flex flex-wrap items-baseline gap-x-1">
            <Price
              amount={product.price_uzs}
              locale={locale}
              {...(old === null ? {} : { currentLabel: dict.product.priceCurrentLabel })}
              data-money
              className={`text-[17px] leading-6 font-bold tabular-nums ${old === null ? '' : 'text-brand-ink'}`}
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
        </span>
        <span
          data-user-text
          className="line-clamp-2 min-h-10 px-0.5 text-sm leading-5 text-foreground/90"
        >
          {name}
        </span>
        {state.kind === 'low' ? (
          <span className="px-0.5 text-xs font-medium text-warning">{stockLabel(state, dict)}</span>
        ) : null}
      </Link>

      {/* Over the photo's bottom edge (the photo is square and full width, so this box matches
          it). Only the control itself takes taps; the rest of the photo stays the link. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex aspect-square items-end justify-end p-1.5">
        {state.kind === 'out' ? (
          <button
            type="button"
            disabled
            aria-label={`${dict.product.outOfStock}: ${name}`}
            className="pointer-events-auto mr-auto inline-flex h-8 items-center rounded-full bg-background/90 px-3 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur"
          >
            {dict.product.outOfStock}
          </button>
        ) : quantity === 0 ? (
          <button
            type="button"
            disabled={!usable}
            onClick={() => change(1)}
            aria-label={`${dict.product.addToCart}: ${name}`}
            className={`${pop}pointer-events-auto inline-flex size-11 items-center justify-center rounded-full bg-background text-primary shadow-[0_2px_8px_rgb(0_0_0/0.16)] ring-1 ring-black/5 enabled:hover:bg-primary enabled:hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60 dark:ring-white/10 ${PRESS} ${FOCUS_RING}`}
          >
            <PlusIcon width={22} height={22} strokeWidth={2.4} />
            <span className="sr-only">{dict.product.addShort}</span>
          </button>
        ) : (
          <div
            role="group"
            aria-label={`${dict.product.quantity}: ${name}`}
            className={`${pop}pointer-events-auto flex h-11 w-full items-center justify-between rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_rgb(0_0_0/0.18)]`}
          >
            <button
              type="button"
              disabled={!usable}
              onClick={() => change(quantity - 1)}
              aria-label={`${quantity <= 1 ? dict.cart.remove : dict.product.decrease}: ${name}`}
              className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
            >
              <MinusIcon width={20} height={20} />
            </button>
            <output aria-live="polite" className="min-w-0 px-1 text-base font-bold tabular-nums">
              {quantity}
            </output>
            <button
              type="button"
              disabled={!usable || quantity >= max}
              onClick={() => change(quantity + 1)}
              aria-label={`${dict.product.increase}: ${name}`}
              className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
            >
              <PlusIcon width={20} height={20} />
            </button>
          </div>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="px-0.5 pt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
