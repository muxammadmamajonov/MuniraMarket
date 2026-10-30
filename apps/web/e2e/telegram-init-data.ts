import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Builds Telegram Mini App `initData` signed the way Telegram does, so the E2E run can log in to
 * a real Core API without a Telegram client. TEST USE ONLY: the bot token comes from the
 * `E2E_TELEGRAM_BOT_TOKEN` environment variable (a throw-away test bot token that the Core API
 * under test is also configured with); nothing here is a real credential.
 *
 * Algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret_key = HMAC_SHA256(key = "WebAppData", msg = bot_token)
 *   hash       = hex(HMAC_SHA256(key = secret_key, msg = data_check_string))
 * where data_check_string is every field except `hash`, as `key=value` lines sorted by key and
 * joined with "\n".
 *
 * Self-check without any test runner:  node e2e/telegram-init-data.ts
 */

export interface FakeTelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export const DEFAULT_E2E_USER: FakeTelegramUser = {
  id: 900_000_001,
  first_name: 'E2E',
  last_name: 'Tester',
  username: 'e2e_tester',
  language_code: 'uz',
};

function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

function dataCheckString(fields: ReadonlyMap<string, string>): string {
  return [...fields.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export interface BuildInitDataOptions {
  botToken: string;
  user?: FakeTelegramUser;
  /** Unix seconds; defaults to now (the API rejects stale `auth_date`s). */
  authDate?: number;
}

/** A valid, freshly signed `Telegram.WebApp.initData` string. */
export function buildSignedInitData({
  botToken,
  user = DEFAULT_E2E_USER,
  authDate = Math.floor(Date.now() / 1000),
}: BuildInitDataOptions): string {
  if (botToken === '') throw new Error('A bot token is required to sign initData.');

  const fields = new Map<string, string>([
    ['auth_date', String(authDate)],
    ['query_id', 'AAE2E2E2E2E2E2E2'],
    ['user', JSON.stringify(user)],
  ]);
  const secretKey = hmac('WebAppData', botToken);
  const hash = hmac(secretKey, dataCheckString(fields)).toString('hex');

  const params = new URLSearchParams();
  for (const [key, value] of fields) params.set(key, value);
  params.set('hash', hash);
  return params.toString();
}

/** Verifies an `initData` string the way the server must; used by the self-check only. */
export function verifyInitData(initData: string, botToken: string): boolean {
  const params = new URLSearchParams(initData);
  const received = params.get('hash');
  if (received === null) return false;
  const fields = new Map(params.entries());
  const expected = hmac(hmac('WebAppData', botToken), dataCheckString(fields)).toString('hex');
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function selfCheck(): void {
  const token = 'test-only-000000:e2e-selfcheck-token';
  const initData = buildSignedInitData({ botToken: token });
  const params = new URLSearchParams(initData);

  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  check('signature verifies with the same token', verifyInitData(initData, token));
  check('signature fails with another token', !verifyInitData(initData, `${token}x`));
  check(
    'tampered user fails',
    !verifyInitData(
      initData.replace(encodeURIComponent('"id":900000001'), encodeURIComponent('"id":1')),
      token,
    ),
  );
  check(
    'contains auth_date, user and hash',
    ['auth_date', 'user', 'hash'].every((k) => params.has(k)),
  );
  check('hash is 64 hex chars', /^[0-9a-f]{64}$/.test(params.get('hash') ?? ''));
  check('auth_date is current', Math.abs(Number(params.get('auth_date')) - Date.now() / 1000) < 5);
  check('user is the fake user', JSON.parse(params.get('user') ?? '{}').id === 900_000_001);

  // Known-answer test against an independently computed value (HMAC-SHA256 per Telegram docs).
  const fixed = buildSignedInitData({
    botToken: token,
    authDate: 1_700_000_000,
    user: { id: 1, first_name: 'A' },
  });
  const expectedHash = hmac(
    hmac('WebAppData', token),
    'auth_date=1700000000\nquery_id=AAE2E2E2E2E2E2E2\nuser={"id":1,"first_name":"A"}',
  ).toString('hex');
  check('known-answer hash', new URLSearchParams(fixed).get('hash') === expectedHash);

  if (failures.length > 0) {
    console.error(`telegram-init-data self-check FAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('telegram-init-data self-check passed');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  selfCheck();
}
