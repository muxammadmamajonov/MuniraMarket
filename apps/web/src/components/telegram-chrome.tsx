'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { canGoBack, isCheckoutPath, isRootPath, parentFor } from '@/lib/back-navigation';
import {
  armFullscreenOnFirstGesture,
  disableVerticalSwipes,
  isMobileTelegram,
  requestFullscreenOnce,
  useBackButton,
  useTelegram,
  useTelegramSafeArea,
  useTelegramTheme,
} from '@/lib/telegram';

/**
 * Mounts Telegram's native chrome for the current page. Renders nothing.
 *
 * - BackButton: the app's only back control (pages draw none). Hidden on the root pages (the
 *   four bottom-nav tabs), shown everywhere else. It goes back in history, or, when there is no
 *   history (the Mini App was opened straight on a product), replaces the page with its logical
 *   parent: a product's category, a category's catalog (see `lib/back-navigation.ts`). On the
 *   checkout page it always goes to the cart, whatever the history holds. The listener is
 *   removed and the button hidden on unmount (`useBackButton`).
 * - MainButton: hidden by default; pages that use it (product, cart, checkout) claim it
 *   themselves with `useMainButton`.
 * - Theme: mirrors Telegram's theme colours onto the design tokens.
 * - Fullscreen (phones only): requested once at launch. Older clients which cannot accept that
 *   request get one first-touch fallback. A refusal leaves the expanded mode. Vertical swipes
 *   scroll instead of closing.
 * - Safe areas: mirrors `safeAreaInset` / `contentSafeAreaInset` (and their change events) onto
 *   the CSS variables the shell pads by (see `lib/telegram/safe-area.ts`).
 */
export function TelegramChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;

  useTelegramTheme();
  useTelegramSafeArea();

  useBackButton({
    visible: !isRootPath(pathname),
    onClick: () => {
      if (!isCheckoutPath(pathname) && canGoBack()) router.back();
      // `replace`, not `push`: the deep-linked page is not left behind the parent, so the next
      // press keeps climbing (product -> category -> catalog) instead of bouncing back.
      else router.replace(parentFor(pathname));
    },
  });

  useEffect(() => {
    disableVerticalSwipes(webApp);
    if (!isMobileTelegram(webApp)) return;
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
