import type { Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { AccountMenu } from './account-menu';
import { CartLink } from './cart-link';
import { ReceiptIcon } from './icons';
import { LanguageSwitcher } from './language-switcher';
import { PageContainer } from './page-container';
import { FOCUS_RING, PRESS } from './ui-classes';
import { Wordmark } from './wordmark';

export interface SiteHeaderProps {
  locale: Locale;
  dict: Dictionary;
}

/**
 * Compact sticky header. Padded by the top and side safe-area insets (notch, Telegram fullscreen,
 * landscape). On phones the wordmark and the language toggle are all it holds: orders, cart and
 * the account live in the bottom tab bar (`bottom-nav.tsx`). From `md` up it is the main
 * navigation: orders, cart, language and, in a browser, the account.
 */
export function SiteHeader({ locale, dict }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background pt-(--mm-inset-top) pr-(--mm-inset-right) pl-(--mm-inset-left)">
      <PageContainer className="flex flex-wrap items-center justify-between gap-x-1 gap-y-0 py-1.5">
        <Link
          href={`/${locale}`}
          aria-label={`${dict.meta.title}: ${dict.nav.home}`}
          className={`-ml-1 inline-flex min-h-11 items-center rounded-xl px-1 ${PRESS} ${FOCUS_RING}`}
        >
          <Wordmark name={dict.meta.title} />
        </Link>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-0.5">
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
          <LanguageSwitcher
            compact
            locale={locale}
            label={dict.language.label}
            names={{ uz: dict.language.uz, ru: dict.language.ru }}
            shortNames={{ uz: dict.language.uzShort, ru: dict.language.ruShort }}
          />
          <div className="max-md:hidden">
            <AccountMenu />
          </div>
        </div>
      </PageContainer>
    </header>
  );
}
