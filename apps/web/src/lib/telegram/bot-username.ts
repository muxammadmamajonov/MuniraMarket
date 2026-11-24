/**
 * The public bot username from `TELEGRAM_BOT_USERNAME`, read on the server at request time (the
 * root layout passes it to `BotUsernameProvider`). Not a secret; `null` when unset or malformed.
 */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function readTelegramBotUsername(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env['TELEGRAM_BOT_USERNAME']?.trim().replace(/^@/, '');
  return raw !== undefined && USERNAME.test(raw) ? raw : null;
}
