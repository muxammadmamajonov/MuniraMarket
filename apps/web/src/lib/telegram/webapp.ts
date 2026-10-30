import type { TelegramWebApp } from './types';

/** Official Telegram Web Apps script. Loaded by the root layout. */
export const TELEGRAM_WEB_APP_SCRIPT_URL = 'https://telegram.org/js/telegram-web-app.js';

/**
 * Returns `window.Telegram.WebApp`, or `null` on the server or when the script has not defined it.
 * SSR-safe.
 *
 * Note that the official script also defines `WebApp` in ordinary browsers (with an empty
 * `initData`), so a non-null result does NOT mean we run inside Telegram; use
 * {@link isTelegramMiniApp} for that.
 */
export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * True only when opened from Telegram, which is the case when signed `initData` is present.
 * This is a UX hint (which UI to show), never a security decision: the server verifies `initData`.
 */
export function isTelegramMiniApp(): boolean {
  const webApp = getTelegramWebApp();
  return webApp !== null && typeof webApp.initData === 'string' && webApp.initData !== '';
}
