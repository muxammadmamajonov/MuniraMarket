'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { useOptionalCart } from '@/lib/cart';
import { BagIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

const BADGE_MAX = 99;

/** Header cart entry: a bag with the number of units in the (server-counted) cart. */
export function CartLink() {
  const { dict, locale } = useI18n();
  const count = useOptionalCart()?.itemCount ?? 0;
  const label =
    count > 0
      ? `${dict.nav.cart}. ${formatMessage(dict.cart.itemCount, { count })}`
      : dict.nav.cart;

  return (
    <Link
      href={`/${locale}/cart`}
      aria-label={label}
      data-testid="header-cart"
      className={`relative inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-2.5 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
    >
      <span className="relative inline-flex">
        <BagIcon />
        {count > 0 ? (
          // Keyed by the count so a change pops once; the first paint (count already set) does not.
          <span
            key={count}
            data-testid="cart-count"
            aria-hidden="true"
            className="mm-pop absolute -top-1.5 -right-2 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] leading-none font-bold text-primary-foreground tabular-nums"
          >
            {count > BADGE_MAX ? `${String(BADGE_MAX)}+` : count}
          </span>
        ) : null}
      </span>
      <span className="sr-only sm:not-sr-only sm:text-sm sm:font-medium">{dict.nav.cart}</span>
    </Link>
  );
}
