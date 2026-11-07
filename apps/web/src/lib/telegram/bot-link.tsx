'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The public bot username (`TELEGRAM_BOT_USERNAME`, read on the server at runtime). Only used to
 * build `https://t.me/<bot>?start=<payload>` links for browser visitors; it is not a secret.
 */
const BotUsernameContext = createContext<string | null>(null);

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function readTelegramBotUsername(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env['TELEGRAM_BOT_USERNAME']?.trim().replace(/^@/, '');
  return raw !== undefined && USERNAME.test(raw) ? raw : null;
}

export function BotUsernameProvider({
  username,
  children,
}: {
  username: string | null;
  children: ReactNode;
}) {
  return <BotUsernameContext.Provider value={username}>{children}</BotUsernameContext.Provider>;
}

/** `https://t.me/<bot>?start=<payload>`, or `null` when no bot username is configured. */
export function useBotStartLink(payload: string): string | null {
  const username = useContext(BotUsernameContext);
  return username === null ? null : `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
}
