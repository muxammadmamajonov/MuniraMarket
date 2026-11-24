import { createHmac, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Settings } from '../config.ts';
import type { Clock } from '../http/context.ts';
import { constantTimeEqual } from '../security/tokens.ts';

/**
 * Verification of Telegram Mini App `initData` (port of services/api/app/telegram/identity.py).
 *
 * - Ed25519 "third-party validation" (default): needs only the bot id and Telegram's published
 *   public key, so the bot token never has to reach this service.
 * - HMAC with the bot token: used only when `TELEGRAM_BOT_TOKEN` is configured.
 */

/** Telegram's published Ed25519 public keys for third-party validation (hex). */
export const TELEGRAM_PUBLIC_KEYS: Readonly<Record<'production' | 'test', string>> = {
  production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
};

export const MAX_FUTURE_SKEW_SECONDS = 60;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_NAME_LENGTH = 255;
const MAX_USERNAME_LENGTH = 64;
const MAX_LANGUAGE_CODE_LENGTH = 16;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** `initData` failed verification. `reason` is a short, non-sensitive label for logs. */
export class InvalidInitData extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidInitData';
    this.reason = reason;
  }
}

export interface VerifiedTelegramIdentity {
  telegramUserId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  authDate: number;
}

export interface TelegramIdentityVerifier {
  verify(initData: string): VerifiedTelegramIdentity;
}

/** Python's `str[:n]` (code points, not UTF-16 units). */
export function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

/** Python `str.strip()` + truncation; `null` for empty. */
function optionalStr(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new InvalidInitData('user_field_type');
  const stripped = value.trim();
  return stripped === '' ? null : truncateCodePoints(stripped, maxLength);
}

/** `urllib.parse.unquote_plus(errors='replace')`. */
function unquotePlus(value: string): string {
  const text = value.replaceAll('+', ' ');
  if (!text.includes('%')) return text;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const codePoint = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

/** `parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)` + duplicate check. */
export function parseInitData(initData: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (initData === '') return fields;
  for (const part of initData.split('&')) {
    const index = part.indexOf('=');
    if (index < 0) throw new InvalidInitData('malformed');
    const key = unquotePlus(part.slice(0, index));
    const value = unquotePlus(part.slice(index + 1));
    if (fields.has(key)) throw new InvalidInitData('duplicate_key');
    fields.set(key, value);
  }
  return fields;
}

function dataCheckString(fields: Map<string, string>, exclude: ReadonlySet<string>): string {
  // Python sorts by code point; compare without locale.
  const keys = [...fields.keys()].filter((key) => !exclude.has(key));
  keys.sort((a, b) => {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      const diff = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
      if (diff !== 0) return diff;
    }
    return left.length - right.length;
  });
  return keys.map((key) => `${key}=${fields.get(key) ?? ''}`).join('\n');
}

abstract class BaseVerifier implements TelegramIdentityVerifier {
  constructor(
    private readonly maxAgeSeconds: number,
    private readonly clock: Clock,
  ) {}

  verify(initData: string): VerifiedTelegramIdentity {
    const fields = parseInitData(initData);
    this.checkSignature(fields);
    const authDate = this.checkAuthDate(fields);
    return buildIdentity(fields, authDate);
  }

  protected abstract checkSignature(fields: Map<string, string>): void;

  protected dataCheckString(fields: Map<string, string>, exclude: ReadonlySet<string>): string {
    return dataCheckString(fields, exclude);
  }

  private checkAuthDate(fields: Map<string, string>): number {
    const raw = fields.get('auth_date');
    if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new InvalidInitData('auth_date_invalid');
    const authDate = Number(raw);
    const now = this.clock();
    if (now - authDate > this.maxAgeSeconds) throw new InvalidInitData('expired');
    if (authDate - now > MAX_FUTURE_SKEW_SECONDS) throw new InvalidInitData('auth_date_in_future');
    return authDate;
  }
}

function buildIdentity(fields: Map<string, string>, authDate: number): VerifiedTelegramIdentity {
  const rawUser = fields.get('user');
  if (rawUser === undefined) throw new InvalidInitData('user_missing');
  let user: unknown;
  try {
    user = JSON.parse(rawUser);
  } catch {
    throw new InvalidInitData('user_malformed');
  }
  if (typeof user !== 'object' || user === null || Array.isArray(user)) {
    throw new InvalidInitData('user_malformed');
  }
  const record = user as Record<string, unknown>;
  const userId = record['id'];
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new InvalidInitData('user_id_invalid');
  }
  const firstName = optionalStr(record['first_name'], MAX_NAME_LENGTH);
  if (firstName === null) throw new InvalidInitData('user_first_name_missing');
  return {
    telegramUserId: userId,
    firstName,
    lastName: optionalStr(record['last_name'], MAX_NAME_LENGTH),
    username: optionalStr(record['username'], MAX_USERNAME_LENGTH),
    languageCode: optionalStr(record['language_code'], MAX_LANGUAGE_CODE_LENGTH),
    authDate,
  };
}

/** Third-party validation: Ed25519 signature over `<bot_id>:WebAppData\n<fields>`. */
export class Ed25519InitDataVerifier extends BaseVerifier {
  private readonly botId: number;
  private readonly publicKey: KeyObject;

  constructor(options: {
    botId: number;
    publicKeyHex: string;
    maxAgeSeconds: number;
    clock: Clock;
  }) {
    super(options.maxAgeSeconds, options.clock);
    this.botId = options.botId;
    this.publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(options.publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  }

  protected checkSignature(fields: Map<string, string>): void {
    const signature = fields.get('signature');
    if (!signature || !B64URL_RE.test(signature) || signature.length % 4 === 1) {
      throw new InvalidInitData('signature_malformed');
    }
    const raw = Buffer.from(signature, 'base64url');
    if (raw.length !== ED25519_SIGNATURE_BYTES) throw new InvalidInitData('signature_malformed');
    const message =
      `${this.botId}:WebAppData\n` + this.dataCheckString(fields, new Set(['hash', 'signature']));
    if (!verify(null, Buffer.from(message, 'utf8'), this.publicKey, raw)) {
      throw new InvalidInitData('signature_mismatch');
    }
  }
}

/** Bot-token validation: `hash` = HMAC-SHA256(HMAC-SHA256("WebAppData", token), fields). */
export class HmacInitDataVerifier extends BaseVerifier {
  private readonly secretKey: Buffer;

  constructor(options: { botToken: string; maxAgeSeconds: number; clock: Clock }) {
    super(options.maxAgeSeconds, options.clock);
    this.secretKey = createHmac('sha256', 'WebAppData').update(options.botToken, 'utf8').digest();
  }

  protected checkSignature(fields: Map<string, string>): void {
    const received = fields.get('hash');
    if (!received) throw new InvalidInitData('hash_missing');
    const expected = createHmac('sha256', this.secretKey)
      .update(this.dataCheckString(fields, new Set(['hash'])), 'utf8')
      .digest('hex');
    if (!constantTimeEqual(expected, received)) throw new InvalidInitData('hash_mismatch');
  }
}

export function buildIdentityVerifier(settings: Settings, clock: Clock): TelegramIdentityVerifier {
  if (settings.telegramBotToken !== null) {
    return new HmacInitDataVerifier({
      botToken: settings.telegramBotToken,
      maxAgeSeconds: settings.telegramInitDataMaxAgeSeconds,
      clock,
    });
  }
  return new Ed25519InitDataVerifier({
    botId: settings.telegramBotId,
    publicKeyHex: TELEGRAM_PUBLIC_KEYS[settings.telegramEnvironment],
    maxAgeSeconds: settings.telegramInitDataMaxAgeSeconds,
    clock,
  });
}
