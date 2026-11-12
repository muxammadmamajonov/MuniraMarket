import type { Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { AccountMenu } from './account-menu';
import { CartLink } from './cart-link';
import { ReceiptIcon } from './icons';
import { PageContainer } from './page-container';
import { FOCUS_RING, PRESS } from './ui-classes';
import { Wordmark } from './wordmark';

export interface SiteHeaderProps {
  locale: Locale;
  dict: Dictionary;
}

/**
 * Compact sticky header. Padded by the top and side safe-area insets (notch, Telegram fullscreen,
 * landscape). On phones the wordmark is all it holds (the language lives only in Profile): orders, cart and
 * the account live in the bottom tab bar (`bottom-nav.tsx`). From `md` up it is the main
 * navigation: orders, cart and, in a browser, the account.
 *
 * Telegram fullscreen on a phone: the header becomes exactly Telegram's own control row
 * (`--mm-tg-content-top` tall, right under the status bar) with the logo centred between the
 * native Close and "…" buttons, the way large Mini Apps brand that row. Everything else on the
 * page starts below it, so nothing ever sits under Telegram's buttons.
 */
export function SiteHeader({ locale, dict }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 pt-(--mm-inset-top) pr-(--mm-inset-right) pl-(--mm-inset-left) backdrop-blur-md max-md:[:root[data-tg-fullscreen]_&]:border-transparent max-md:[:root[data-tg-fullscreen]_&]:pt-(--mm-safe-top)">
      {/* In Telegram fullscreen the row is Telegram's control row: centred logo, no nav (the tab
          bar has it), height taken from Telegram's content inset (44px if it reports none). */}
      <PageContainer className="flex flex-wrap items-center justify-between gap-x-1 gap-y-0 py-1.5 max-md:[:root[data-tg-fullscreen]_&]:h-[max(2.75rem,var(--mm-tg-content-top))] max-md:[:root[data-tg-fullscreen]_&]:flex-nowrap max-md:[:root[data-tg-fullscreen]_&]:justify-center max-md:[:root[data-tg-fullscreen]_&]:py-0">
        <Link
          href={`/${locale}`}
          aria-label={`${dict.meta.title}: ${dict.nav.home}`}
          data-testid="header-logo"
          className={`-ml-1 inline-flex min-h-11 items-center rounded-xl px-1 max-md:[:root[data-tg-fullscreen]_&]:ml-0 ${PRESS} ${FOCUS_RING}`}
        >
          <Wordmark name={dict.meta.title} />
        </Link>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-0.5 max-md:[:root[data-tg-fullscreen]_&]:hidden">
          <nav
            aria-label={dict.nav.mainNavigation}
            className="flex items-center gap-x-0.5 max-md:hidden"
          >
            <Link
              href={`/${locale}/orders`}
              aria-label={dict.nav.orders}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-2.5 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
            >
              <ReceiptIcon />
              <span className="sr-only sm:not-sr-only sm:text-sm sm:font-medium">
                {dict.nav.orders}
              </span>
            </Link>
            <CartLink />
          </nav>
          <div className="max-md:hidden">
            <AccountMenu />
          </div>
        </div>
      </PageContainer>
    </header>
  );
}
