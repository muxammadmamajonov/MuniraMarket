'use client';

import { formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useOptionalCart } from '@/lib/cart';
import { useMainButton, useTelegram } from '@/lib/telegram';
import { BagIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

/**
 * "Go to cart" bar for pages with product cards. In a browser it is a bar pinned above the bottom
 * safe area with the unit count and the server's total; it slides up once, when the first item is
 * added, and is just there on later visits. Inside Telegram the native MainButton does the same
 * job (as it already does on the cart and checkout pages), so no web bar is drawn there. Renders
 * nothing while the cart is empty.
 */
export function CartBar() {
  const { dict, locale } = useI18n();
  const router = useRouter();
  const telegram = useTelegram();
  const cart = useOptionalCart();
  const count = cart?.itemCount ?? 0;
  const total = formatUZS(cart?.totalUzs ?? 0, locale);
  const cartHref = `/${locale}/cart`;
  const inTelegram = telegram.kind === 'telegram';

  // Slide in only if the cart was empty when the page showed up (the customer just added the
  // first item); a bar that is already due on arrival appears without ceremony.
  const [animateIn] = useState(count === 0);
  // Feedback for every later add/remove: the count badge pops (keyed by the count, so each change
  // replays it) and the change is announced politely. Not on the first render of a page.
  const [initialCount] = useState(count);
  const changed = count !== initialCount;

  useMainButton(
    inTelegram && count > 0
      ? { text: `${dict.product.viewCart} — ${total}`, onClick: () => router.push(cartHref) }
      : null,
  );

  if (count === 0 || inTelegram) return null;

  return (
    <>
      {/* Keeps the last row of cards clear of the fixed bar. */}
      <div aria-hidden="true" className="h-20" />
      <div
        data-testid="cart-bar"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 pb-[env(safe-area-inset-bottom,0px)]"
      >
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 sm:px-6">
          <Link
            href={cartHref}
            className={`pointer-events-auto ${animateIn ? 'mm-bar-in ' : ''}flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-primary px-4 text-primary-foreground shadow-lg hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <BagIcon className="shrink-0" />
              <span className="truncate font-semibold">{dict.product.viewCart}</span>
              <span
                key={count}
                data-testid="cart-bar-count"
                className={`${changed ? 'mm-pop ' : ''}rounded-full bg-primary-foreground/20 px-2 py-0.5 text-sm font-semibold tabular-nums`}
              >
                {count}
              </span>
            </span>
            <span data-money data-testid="cart-bar-total" className="shrink-0 font-bold">
              {total}
            </span>
          </Link>
          <p aria-live="polite" className="sr-only">
            {changed ? `${dict.product.viewCart}: ${count}, ${total}` : ''}
          </p>
        </div>
      </div>
    </>
  );
}
