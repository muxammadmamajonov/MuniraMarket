import type { TelegramWebApp } from './types';

/**
 * `WebApp.requestContact()` as a promise. Telegram shows its own consent popup; on "share" the
 * user's OWN number is sent to the bot as a contact message (verified by the bot handler and
 * stored by the Core API). This page never sees the number: the callback only says whether the
 * user agreed, so the caller then waits for the session to report `phone_verified`.
 */

export type ContactRequestOutcome = 'shared' | 'cancelled' | 'unsupported';

export function canRequestContact(webApp: TelegramWebApp | null): webApp is TelegramWebApp {
  if (webApp === null || typeof webApp.requestContact !== 'function') return false;
  try {
    return webApp.isVersionAtLeast?.('6.9') ?? false;
  } catch {
    return false;
  }
}

export function requestContact(webApp: TelegramWebApp | null): Promise<ContactRequestOutcome> {
  if (!canRequestContact(webApp)) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    try {
      webApp.requestContact?.((shared) => resolve(shared ? 'shared' : 'cancelled'));
    } catch {
      resolve('unsupported');
    }
  });
}
