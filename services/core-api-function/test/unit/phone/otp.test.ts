import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramGatewayProvider,
  disabledOtpProvider,
  phoneOtpProvider,
} from '../../../src/phone/otp.ts';

const TOKEN = 'test-gateway-token-not-real';

function fakeFetch(result: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(result), { status }));
}

describe('phone OTP provider', () => {
  it('is disabled unless explicitly configured with a token', async () => {
    const fetch = fakeFetch({});
    expect(
      phoneOtpProvider({ phoneOtpProvider: 'disabled', telegramGatewayToken: TOKEN }, fetch),
    ).toBe(disabledOtpProvider);
    expect(
      phoneOtpProvider({ phoneOtpProvider: 'telegram_gateway', telegramGatewayToken: null }, fetch),
    ).toBe(disabledOtpProvider);
    expect(await disabledOtpProvider.send('+998901234567')).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends through Telegram Gateway with a bearer token and returns the request id', async () => {
    const fetch = fakeFetch({
      ok: true,
      result: { request_id: 'req_123', phone_number: '+998901234567' },
    });
    const provider = createTelegramGatewayProvider({ token: TOKEN, fetch });
    expect(await provider.send('+998901234567')).toEqual({ ok: true, requestId: 'req_123' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gatewayapi.telegram.org/sendVerificationMessage');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      phone_number: '+998901234567',
      code_length: 6,
      ttl: 300,
    });
  });

  it('refuses malformed numbers without calling the provider', async () => {
    const fetch = fakeFetch({});
    const provider = createTelegramGatewayProvider({ token: TOKEN, fetch });
    expect(await provider.send('998901234567')).toEqual({
      ok: false,
      reason: 'unsupported_number',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['code_valid', { ok: true }],
    ['code_invalid', { ok: false, reason: 'code_invalid' }],
    ['code_max_attempts_exceeded', { ok: false, reason: 'too_many_attempts' }],
    ['expired', { ok: false, reason: 'expired' }],
  ])('maps verification status %s', async (status, expected) => {
    const fetch = fakeFetch({
      ok: true,
      result: { request_id: 'req_1', verification_status: { status } },
    });
    const provider = createTelegramGatewayProvider({ token: TOKEN, fetch });
    expect(await provider.check('req_1', '123456')).toEqual(expected);
  });

  it('turns provider failures into a stable reason and never leaks the token', async () => {
    const failing = createTelegramGatewayProvider({
      token: TOKEN,
      fetch: fakeFetch({ ok: false, error: 'ACCESS_TOKEN_INVALID' }, 401),
    });
    const result = await failing.send('+998901234567');
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const throwing = createTelegramGatewayProvider({
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    expect(await throwing.check('req_1', '123456')).toEqual({
      ok: false,
      reason: 'provider_error',
    });
  });
});
