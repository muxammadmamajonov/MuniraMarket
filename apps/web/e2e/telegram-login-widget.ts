import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Builds the signed fields of a Telegram Login Widget redirect, the way Telegram does, so the E2E
 * run can sign in to the admin app without a Telegram account. TEST USE ONLY: the bot token comes
 * from the `E2E_TELEGRAM_BOT_TOKEN` environment variable (a throw-away test bot token that the
 * Core API under test is also configured with); nothing here is a real credential.
 *
 * Algorithm (https://core.telegram.org/widgets/login#checking-authorization), which is also what
 * `services/api/app/telegram/login_widget.py` verifies:
 *   secret_key = SHA256(bot_token)
 *   hash       = hex(HMAC_SHA256(key = secret_key, msg = data_check_string))
 * where data_check_string is every received field except `hash`, as `key=value` lines sorted by
 * key and joined with "\n". Unlike Mini App initData there is no "WebAppData" prefix step.
 *
 * Self-check without any test runner:  node e2e/telegram-login-widget.ts
 */

export interface FakeLoginWidgetUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

function dataCheckString(fields: Readonly<Record<string, string>>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'hash')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
}

export interface BuildLoginWidgetFieldsOptions {
  botToken: string;
  user: FakeLoginWidgetUser;
  /** Unix seconds; defaults to now (the API rejects payloads older than its max age). */
  authDate?: number;
}

/** The query fields the widget appends to `data-auth-url`: the user, `auth_date` and `hash`. */
export function buildSignedLoginWidgetFields({
  botToken,
  user,
  authDate = Math.floor(Date.now() / 1000),
}: BuildLoginWidgetFieldsOptions): Record<string, string> {
  if (botToken === '') throw new Error('A bot token is required to sign Login Widget fields.');

  const fields: Record<string, string> = {
    id: String(user.id),
    first_name: user.first_name,
    auth_date: String(authDate),
  };
  if (user.last_name !== undefined) fields['last_name'] = user.last_name;
  if (user.username !== undefined) fields['username'] = user.username;
  if (user.photo_url !== undefined) fields['photo_url'] = user.photo_url;

  const secretKey = createHash('sha256').update(botToken).digest();
  fields['hash'] = hmac(secretKey, dataCheckString(fields)).toString('hex');
  return fields;
}

/**
 * Where the widget sends the browser after the user authorises: `data-auth-url` (which may carry
 * its own query, such as the admin's one-time `state`) with the signed fields appended.
 */
export function buildLoginWidgetRedirect(
  authUrl: string,
  fields: Readonly<Record<string, string>>,
): string {
  const url = new URL(authUrl);
  for (const [key, value] of Object.entries(fields)) url.searchParams.append(key, value);
  return url.toString();
}

/** Verifies fields the way the server must; used by the self-check only. */
export function verifyLoginWidgetFields(
  fields: Readonly<Record<string, string>>,
  botToken: string,
): boolean {
  const received = fields['hash'];
  if (received === undefined) return false;
  const secretKey = createHash('sha256').update(botToken).digest();
  const expected = hmac(secretKey, dataCheckString(fields));
  const actual = Buffer.from(received, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function selfCheck(): void {
  const token = 'test-only-000000:e2e-selfcheck-token';
  const user: FakeLoginWidgetUser = { id: 990_000_001, first_name: 'A', username: 'a_user' };
  const fields = buildSignedLoginWidgetFields({ botToken: token, user });

  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  check('signature verifies with the same token', verifyLoginWidgetFields(fields, token));
  check('signature fails with another token', !verifyLoginWidgetFields(fields, `${token}x`));
  check('tampered id fails', !verifyLoginWidgetFields({ ...fields, id: '1' }, token));
  check('hash is 64 hex chars', /^[0-9a-f]{64}$/.test(fields['hash'] ?? ''));
  check('auth_date is current', Math.abs(Number(fields['auth_date']) - Date.now() / 1000) < 5);

  // Known-answer test against an independently computed value (Telegram's documented algorithm).
  const fixed = buildSignedLoginWidgetFields({
    botToken: token,
    authDate: 1_700_000_000,
    user: { id: 1, first_name: 'A' },
  });
  const expectedHash = hmac(
    createHash('sha256').update(token).digest(),
    'auth_date=1700000000\nfirst_name=A\nid=1',
  ).toString('hex');
  check('known-answer hash', fixed['hash'] === expectedHash);

  // The redirect keeps the state the app put in `data-auth-url` and appends the fields with `&`.
  const redirect = new URL(
    buildLoginWidgetRedirect('http://localhost:3001/uz/auth/telegram?state=abc', fixed),
  );
  check('redirect keeps state', redirect.searchParams.get('state') === 'abc');
  check('redirect carries hash', redirect.searchParams.get('hash') === expectedHash);
  check('redirect path', redirect.pathname === '/uz/auth/telegram');

  if (failures.length > 0) {
    console.error(`telegram-login-widget self-check FAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('telegram-login-widget self-check passed');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  selfCheck();
}
