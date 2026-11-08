/**
 * Phone ownership by one-time code, behind a provider interface.
 *
 * A plain bot token CANNOT send codes through Telegram's official "Verification Codes" channel;
 * that is the separate Telegram Gateway API (https://core.telegram.org/gateway/api): its own
 * account and access token, prepaid credits, charged per delivered code. So the provider is
 * `disabled` unless `PHONE_OTP_PROVIDER=telegram_gateway` AND `TELEGRAM_GATEWAY_TOKEN` are set
 * (src/config.ts refuses the first without the second).
 *
 * The verified phone used today needs no code at all: the user shares their own Telegram contact
 * with the bot (`POST internal/telegram/phone`). This interface is for numbers that are NOT the
 * Telegram account's own.
 *
 * Phone numbers, codes and the token are never logged; errors carry only a stable reason.
 */
import type { FetchFn } from '../http/context.ts';

export type OtpSendResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: 'disabled' | 'unsupported_number' | 'provider_error' };

export type OtpCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'disabled' | 'code_invalid' | 'too_many_attempts' | 'expired' | 'provider_error';
    };

export interface PhoneOtpProvider {
  readonly name: 'disabled' | 'telegram_gateway';
  readonly enabled: boolean;
  /** Sends a code to an E.164 number; resolves with the provider's request id. */
  send(phoneE164: string): Promise<OtpSendResult>;
  /** Checks the code the user typed for that request. */
  check(requestId: string, code: string): Promise<OtpCheckResult>;
}

export const disabledOtpProvider: PhoneOtpProvider = {
  name: 'disabled',
  enabled: false,
  send: () => Promise.resolve({ ok: false, reason: 'disabled' }),
  check: () => Promise.resolve({ ok: false, reason: 'disabled' }),
};

export const TELEGRAM_GATEWAY_ORIGIN = 'https://gatewayapi.telegram.org';
const E164 = /^\+[1-9]\d{6,14}$/;
const CODE = /^\d{4,8}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface GatewayEnvelope {
  ok?: unknown;
  result?: {
    request_id?: unknown;
    verification_status?: { status?: unknown };
  };
}

export interface TelegramGatewayOptions {
  token: string;
  fetch: FetchFn;
  /** Code lifetime in seconds (Gateway allows 30..3600). */
  ttlSeconds?: number;
  codeLength?: number;
  timeoutMs?: number;
}

export function createTelegramGatewayProvider(options: TelegramGatewayOptions): PhoneOtpProvider {
  const ttl = Math.min(3600, Math.max(30, options.ttlSeconds ?? 300));
  const codeLength = Math.min(8, Math.max(4, options.codeLength ?? 6));
  const timeoutMs = options.timeoutMs ?? 8000;

  async function post(
    method: string,
    body: Record<string, unknown>,
  ): Promise<GatewayEnvelope | null> {
    try {
      const response = await options.fetch(`${TELEGRAM_GATEWAY_ORIGIN}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      return (await response.json()) as GatewayEnvelope;
    } catch {
      return null;
    }
  }

  return {
    name: 'telegram_gateway',
    enabled: true,
    async send(phoneE164) {
      if (!E164.test(phoneE164)) return { ok: false, reason: 'unsupported_number' };
      const envelope = await post('sendVerificationMessage', {
        phone_number: phoneE164,
        code_length: codeLength,
        ttl,
      });
      const requestId = envelope?.result?.request_id;
      if (envelope?.ok !== true || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
        return { ok: false, reason: 'provider_error' };
      }
      return { ok: true, requestId };
    },
    async check(requestId, code) {
      if (!REQUEST_ID.test(requestId) || !CODE.test(code))
        return { ok: false, reason: 'code_invalid' };
      const envelope = await post('checkVerificationStatus', { request_id: requestId, code });
      if (envelope?.ok !== true) return { ok: false, reason: 'provider_error' };
      switch (envelope.result?.verification_status?.status) {
        case 'code_valid':
          return { ok: true };
        case 'code_invalid':
          return { ok: false, reason: 'code_invalid' };
        case 'code_max_attempts_exceeded':
          return { ok: false, reason: 'too_many_attempts' };
        case 'expired':
          return { ok: false, reason: 'expired' };
        default:
          return { ok: false, reason: 'provider_error' };
      }
    },
  };
}

/** The configured provider: Telegram Gateway only when explicitly enabled with a token. */
export function phoneOtpProvider(
  settings: {
    phoneOtpProvider: 'disabled' | 'telegram_gateway';
    telegramGatewayToken: string | null;
  },
  fetch: FetchFn,
): PhoneOtpProvider {
  if (settings.phoneOtpProvider === 'telegram_gateway' && settings.telegramGatewayToken !== null) {
    return createTelegramGatewayProvider({ token: settings.telegramGatewayToken, fetch });
  }
  return disabledOtpProvider;
}
