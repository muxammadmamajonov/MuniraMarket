'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useI18n } from '@/i18n/context';
import { localeFromPathname } from '@/i18n/switch-locale';
import { useBackButton, useTelegram, useTelegramTheme } from '@/lib/telegram';

/** True for `/<locale>` (the home page), where there is nothing to go back to. */
export function isHomePath(pathname: string): boolean {
  return localeFromPathname(pathname) !== null && pathname.split('/').filter(Boolean).length === 1;
}

/**
 * Mounts Telegram's native chrome for the current page. Renders nothing.
 *
 * - BackButton: visible on every page except home; goes back in history, or to home when there
 *   is no history (for example the Mini App was opened straight on a product).
 * - MainButton: hidden by default; pages that use it (the product page) claim it themselves with
 *   `useMainButton`. The cart page deliberately leaves it hidden, see `app/[locale]/cart`.
 * - Theme: mirrors Telegram's theme colours onto the design tokens.
 */
export function TelegramChrome() {
  const pathname = usePathname();
  const router = useRouter();
  const { locale } = useI18n();
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;

  useTelegramTheme();

  useBackButton({
    visible: !isHomePath(pathname),
    onClick: () => {
      if (window.history.length > 1) router.back();
      else router.push(`/${locale}`);
    },
  });

  // A MainButton left visible by a previous page of the same webview must not leak onto pages
  // that do not use it.
  useEffect(() => {
    webApp?.MainButton.hide();
  }, [webApp]);

  return null;
}
