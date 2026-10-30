import type { Locale } from '@muniramarket/contracts';
import { PageContainer } from './page-container';
import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { AccountMenu } from './account-menu';
import { LanguageSwitcher } from './language-switcher';

export interface SiteHeaderProps {
  locale: Locale;
  dict: Dictionary;
}

const NAV_LINK =
  'inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium hover:bg-surface-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function SiteHeader({ locale, dict }: SiteHeaderProps) {
  return (
    <header className="border-b border-border bg-background pt-[env(safe-area-inset-top)]">
      <PageContainer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <nav aria-label={dict.nav.mainNavigation} className="flex items-center gap-1">
          <Link href={`/${locale}`} className={`${NAV_LINK} text-base font-bold`}>
            {dict.meta.title}
          </Link>
          <Link href={`/${locale}/cart`} className={NAV_LINK}>
            {dict.nav.cart}
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <AccountMenu />
          <LanguageSwitcher
            locale={locale}
            label={dict.language.label}
            names={{ uz: dict.language.uz, ru: dict.language.ru }}
          />
        </div>
      </PageContainer>
    </header>
  );
}
