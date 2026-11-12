'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useI18n } from '@/i18n/context';
import { localeFromPathname } from '@/i18n/switch-locale';
import {
  armFullscreenOnFirstGesture,
  disableVerticalSwipes,
  requestFullscreenOnce,
  useBackButton,
  useTelegram,
  useTelegramSafeArea,
  useTelegramTheme,
} from '@/lib/telegram';

/** True for `/<locale>` (the home page), where there is nothing to go back to. */
export function isHomePath(pathname: string): boolean {
  return localeFromPathname(pathname) !== null && pathname.split('/').filter(Boolean).length === 1;
}

/** True for `/<locale>/checkout`, whose BackButton always returns to the cart. */
export function isCheckoutPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return (
    localeFromPathname(pathname) !== null && segments.length === 2 && segments[1] === 'checkout'
  );
}

/**
 * Mounts Telegram's native chrome for the current page. Renders nothing.
 *
 * - BackButton: visible on every page except home; goes back in history, or to home when there
 *   is no history (for example the Mini App was opened straight on a product). On the checkout
 *   page it always goes to the cart, whatever the history holds.
 * - MainButton: hidden by default; pages that use it (product, cart, checkout) claim it
 *   themselves with `useMainButton`.
 * - Theme: mirrors Telegram's theme colours onto the design tokens.
 * - Fullscreen (phones only): requested once on the first tap, see `armFullscreenOnFirstGesture`;
 *   a refusal or an old client leaves the expanded mode. Vertical swipes scroll instead of closing.
 * - Safe areas: mirrors `safeAreaInset` / `contentSafeAreaInset` (and their change events) onto
 *   the CSS variables the shell pads by (see `lib/telegram/safe-area.ts`).
 */
export function TelegramChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const { locale } = useI18n();
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;

  useTelegramTheme();
  useTelegramSafeArea();

  useBackButton({
    visible: !isHomePath(pathname),
    onClick: () => {
      if (isCheckoutPath(pathname)) router.replace(`/${locale}/cart`);
      else if (window.history.length > 1) router.back();
      else router.push(`/${locale}`);
    },
  });

  useEffect(() => {
    disableVerticalSwipes(webApp);
    // Request on launch: pressing the bot's Open App / menu button was the user gesture. This
    // avoids the initial compact sheet seen on iOS. A client that rejects it still gets one
    // first-touch retry for compatibility with older Telegram builds.
    const requested = requestFullscreenOnce(webApp);
    return requested ? undefined : armFullscreenOnFirstGesture(webApp);
  }, [webApp]);

  // A MainButton left visible by a previous page of the same webview must not leak onto pages
  // that do not use it.
  useEffect(() => {
    webApp?.MainButton.hide();
  }, [webApp]);

  return null;
}
