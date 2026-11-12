import type { Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { AccountMenu } from './account-menu';
import { BackParent } from './back-parent';
import { CartLink } from './cart-link';
import { ReceiptIcon } from './icons';
import { OfflineBanner } from './offline-banner';
import { PageContainer } from './page-container';
import { FOCUS_RING, PRESS } from './ui-classes';
import { MuniraMark, Wordmark } from './wordmark';

export interface SiteHeaderProps {
  locale: Locale;
  dict: Dictionary;
  /**
   * The page title, shown where the home page shows the logo (and the page's only `h1`). Omit it
   * on the home page. `null`: an inner page whose title is not known yet (loading), so the slot
   * stays empty instead of flashing the logo.
   */
  title?: string | null | undefined;
  /** Where Telegram's BackButton leads when there is no history (see `lib/back-navigation.ts`). */
  parentHref?: string;
}

/**
 * Compact sticky header, rendered by each page (so its title is in the server HTML, never swapped
 * in after hydration). Padded by the top and side safe-area insets (notch, Telegram fullscreen,
 * landscape). The home page shows the wordmark; every other page shows its title in the same
 * slot, cut with an ellipsis when long. There is no back button: inside Telegram the native
 * BackButton does that job, in a browser the browser's own.
 *
 * On phones the title (or wordmark) is all it holds: orders, cart and the account live in the
 * bottom tab bar (`bottom-nav.tsx`). From `md` up it is the main navigation (orders, cart and,
 * in a browser, the account), and inner pages keep a small mark linking home, since there is no
 * tab bar there.
 *
 * Telegram fullscreen on a phone: the header is exactly Telegram's own control row
 * (`--mm-tg-content-top` tall, right under the status bar), and the title or logo is centred
 * between the native Close and "…" buttons, kept clear of them by `--mm-tg-controls` on each side.
 * Everything else on the page starts below it, so nothing ever sits under Telegram's buttons.
 *
 * Solid background, no `backdrop-filter`: a blurred sticky bar is re-composited on every scroll
 * frame, which is what made scrolling stutter in Android webviews.
 */
export function SiteHeader({ locale, dict, title, parentHref }: SiteHeaderProps) {
  const home = `/${locale}`;
  const homeLabel = `${dict.meta.title}: ${dict.nav.home}`;
  const isHome = title === undefined;

  return (
    <>
      <header
        data-page-header={isHome ? 'logo' : 'title'}
        className="sticky top-0 z-40 border-b border-border bg-background pt-(--mm-inset-top) pr-(--mm-inset-right) pl-(--mm-inset-left) max-md:[:root[data-tg-fullscreen]_&]:border-transparent max-md:[:root[data-tg-fullscreen]_&]:pt-(--mm-safe-top)"
      >
        {/* In Telegram fullscreen the row is Telegram's control row: centred logo or title, no
            nav (the tab bar has it), height taken from Telegram's content inset (44px if it
            reports none). */}
        <PageContainer className="flex min-h-14 items-center justify-between gap-x-1 py-1.5 max-md:[:root[data-tg-fullscreen]_&]:h-[max(2.75rem,var(--mm-tg-content-top))] max-md:[:root[data-tg-fullscreen]_&]:min-h-0 max-md:[:root[data-tg-fullscreen]_&]:justify-center max-md:[:root[data-tg-fullscreen]_&]:py-0">
          {isHome ? (
            <Link
              href={home}
              aria-label={homeLabel}
              data-testid="header-logo"
              className={`-ml-1 inline-flex min-h-11 items-center rounded-xl px-1 max-md:[:root[data-tg-fullscreen]_&]:ml-0 ${PRESS} ${FOCUS_RING}`}
            >
              <Wordmark name={dict.meta.title} />
            </Link>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 max-md:[:root[data-tg-fullscreen]_&]:max-w-[calc(100%-2*var(--mm-tg-controls))] max-md:[:root[data-tg-fullscreen]_&]:justify-center">
              <Link
                href={home}
                aria-label={homeLabel}
                data-testid="header-home"
                className={`-ml-1 hidden min-h-11 shrink-0 items-center rounded-xl px-1 md:inline-flex ${PRESS} ${FOCUS_RING}`}
              >
                <MuniraMark className="size-8" />
              </Link>
              {title === null ? null : (
                <h1
                  data-testid="header-title"
                  title={title}
                  className="min-w-0 truncate text-[17px] leading-6 font-semibold tracking-[-0.01em] max-md:[:root[data-tg-fullscreen]_&]:text-center"
                >
                  {title}
                </h1>
              )}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center justify-end gap-x-0.5 max-md:hidden">
            <nav aria-label={dict.nav.mainNavigation} className="flex items-center gap-x-0.5">
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
            <AccountMenu />
          </div>
        </PageContainer>
      </header>
      {parentHref === undefined ? null : <BackParent href={parentHref} />}
      {/* Below the header: the header pads itself by the top safe-area inset, so a banner above
          it would sit under the notch / status bar in fullscreen and installed modes. */}
      <OfflineBanner />
    </>
  );
}
