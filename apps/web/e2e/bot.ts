/**
 * Stand-in for the Telegram bot in E2E: the same signed Core API calls the bot makes (ADR 0003) when a user picks a
 * language on the first `/start` or shares their own contact (same canonical string as its
 * `lib/coreApi/signer.js`). Playwright cannot drive a Telegram
 * chat, so this is how the "contact arrives through the bot" half of the Mini App phone flow runs.
 *
 * Signs with the local/CI stack's throw-away key (`SERVICE_AUTH_KEYS`; override with
 * `E2E_SERVICE_SIGNER=keyId:key`), never a real one.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FakeTelegramUser } from './telegram-init-data';

// The CI/local stack's throw-away signing key (its SERVICE_AUTH_KEYS), not a real credential.
const DEFAULT_SIGNER = 'ci:ci-only-service-key-not-a-secret-000000';

/** Hex HMAC-SHA256 request signature (ADR 0003). A MAC over the request, not a stored hash. */
function signatureOf(signingKey: string, canonical: string): string {
  return createHmac('sha256', signingKey).update(canonical).digest('hex');
}

/** ADR 0003 (`MM-SVC-V1`), the same canonical string as the bot's `lib/coreApi/signer.js`. */
async function signed(method: string, path: string, actorId: number, json: unknown) {
  const [keyId, signingKey] = (process.env['E2E_SERVICE_SIGNER'] ?? DEFAULT_SIGNER).split(':');
  if (!keyId || !signingKey) throw new Error('E2E_SERVICE_SIGNER must look like keyId:key');
  const body = JSON.stringify(json);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const actor = `tg:${actorId}`;
  const canonical = [
    'MM-SVC-V1',
    keyId,
    timestamp,
    nonce,
    method,
    path,
    actor,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  const signature = signatureOf(signingKey, canonical);
  const response = await fetch(`${process.env['E2E_API_URL'] ?? 'http://127.0.0.1:8000'}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-MM-Key-Id': keyId,
      'X-MM-Timestamp': timestamp,
      'X-MM-Nonce': nonce,
      'X-MM-Actor': actor,
      'X-MM-Signature': signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`bot stand-in: ${method} ${path} -> ${response.status}`);
}

const client = () => ({
  syncTelegramUser: (user: FakeTelegramUser) =>
    signed('POST', '/api/v1/internal/telegram/session', user.id, {
      telegram_user_id: user.id,
      first_name: user.first_name,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
      language_code: user.language_code ?? null,
    }),
  setLanguage: (id: number, language: 'uz' | 'ru') =>
    signed('PUT', '/api/v1/internal/telegram/language', id, { language }),
  recordOwnPhone: (id: number, phone: string) =>
    signed('POST', '/api/v1/internal/telegram/phone', id, {
      contact_user_id: id,
      phone_number: phone,
    }),
});

/** The bot's `/start` user sync (creates the user if needed). */
export async function botSyncUser(user: FakeTelegramUser): Promise<void> {
  await client().syncTelegramUser(user);
}

/** The bot's language buttons: saves the user's choice as their one language preference. */
export async function botChooseLanguage(user: FakeTelegramUser, language: 'uz' | 'ru') {
  await botSyncUser(user);
  await client().setLanguage(user.id, language);
}

/** The bot receiving the user's OWN contact (what `requestContact()` makes Telegram send). */
export async function botReceivesOwnContact(user: FakeTelegramUser, phone: string) {
  await botSyncUser(user);
  await client().recordOwnPhone(user.id, phone);
}

/** E2E users get a distinct, plausible demo number per Telegram id (never a real person's). */
export function demoPhoneFor(user: FakeTelegramUser): string {
  return `+99890${String(user.id % 10_000_000).padStart(7, '0')}`;
}
