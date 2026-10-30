'use client';

import { useEffect, useRef } from 'react';
import { useI18n } from '@/i18n/context';

/** Official Telegram Login Widget script. Loaded only when the API says the widget is enabled. */
export const TELEGRAM_LOGIN_WIDGET_SCRIPT_URL = 'https://telegram.org/js/telegram-widget.js?22';

/** Bot usernames are 5-32 chars of [A-Za-z0-9_]; refuse anything else before using it in the DOM. */
const BOT_USERNAME = /^[A-Za-z0-9_]{3,64}$/;

/** Path (below the locale) that finishes the login; see `app/[locale]/auth/telegram/page.tsx`. */
export const LOGIN_CALLBACK_PATH = 'auth/telegram';

export interface TelegramLoginButtonProps {
  botUsername: string;
}

/**
 * Renders the official Telegram Login Widget.
 *
 * Deliberate deviation from the widget's documented `data-onauth="callback(user)"` mode: the
 * script runs that attribute through `eval`, which our CSP forbids (no `'unsafe-eval'`). We use
 * the redirect mode (`data-auth-url`) instead: after login Telegram sends the browser to
 * `/<locale>/auth/telegram?id=...&hash=...`, whose page POSTs those fields to
 * `/api/v1/auth/telegram/login-widget`. The script is injected by our own nonce'd bundle, which
 * `'strict-dynamic'` allows, and the widget iframe is covered by `frame-src`.
 */
export function TelegramLoginButton({ botUsername }: TelegramLoginButtonProps) {
  const { locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null || !BOT_USERNAME.test(botUsername)) return undefined;

    const script = document.createElement('script');
    script.async = true;
    script.src = TELEGRAM_LOGIN_WIDGET_SCRIPT_URL;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute(
      'data-auth-url',
      `${window.location.origin}/${locale}/${LOGIN_CALLBACK_PATH}`,
    );
    element.appendChild(script);

    return () => {
      element.replaceChildren();
    };
  }, [botUsername, locale]);

  return <div ref={container} data-testid="telegram-login-widget" className="min-h-12" />;
}
