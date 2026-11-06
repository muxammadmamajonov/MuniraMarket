import { describe, expect, it } from 'vitest';
import { createBotApi, type FetchFn } from '../src/botApi';
import { BotApiError } from '../src/telegramSdk';
// The same module the scheduler bundles: errors must classify through it.
import { createTelegramBotTransport } from '../../telegram/tgcloud/lib/notifications/transport.js';

// Test-only token shape; not a real bot token.
const TOKEN = '123456789:TEST_ONLY_token_not_real_aaaaaaaaaaaaaa';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('createBotApi', () => {
  it('POSTs JSON to the Bot API method and resolves with result', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { ok: true, result: { message_id: 7 } }));
    const api = createBotApi(TOKEN, fn);
    await expect(api.sendMessage({ chat_id: -100123, text: 'hi' })).resolves.toEqual({
      message_id: 7,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ chat_id: -100123, text: 'hi' });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 403, 429, 500, 502])(
    'maps Bot API error_code %i to BotApiError without the description or token',
    async (code) => {
      const { fn } = fakeFetch(() =>
        json(code, {
          ok: false,
          error_code: code,
          description: `Forbidden: bot was kicked from chat -100123 ${TOKEN}`,
          parameters: { retry_after: 5, note: 'text' },
        }),
      );
      const error = await rejection(createBotApi(TOKEN, fn).sendMessage({ chat_id: 1, text: 'x' }));
      expect(error).toBeInstanceOf(BotApiError);
      const botError = error as BotApiError;
      expect(botError.code).toBe(code);
      expect(botError.method).toBe('sendMessage');
      expect(botError.description).toBe('');
      expect(botError.parameters).toEqual({ retry_after: 5 });
      const visible = `${botError.message} ${JSON.stringify(botError)} ${String(botError.stack)}`;
      expect(visible).not.toContain(TOKEN);
      expect(visible).not.toContain('api.telegram.org');
      expect(visible).not.toContain('kicked');
    },
  );

  it('uses the HTTP status when the error body is not JSON', async () => {
    const { fn } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await rejection(createBotApi(TOKEN, fn).sendMessage({}));
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).code).toBe(502);
  });

  it('rejects with a plain Error (not BotApiError) on network failures, never quoting the URL', async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const error = await rejection(createBotApi(TOKEN, fn).sendMessage({}));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BotApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).stack)).not.toContain(TOKEN);
    expect((error as Error).cause).toBeUndefined();
  });

  it('rejects with a plain Error on a 200 that is not ok:true', async () => {
    const { fn } = fakeFetch(() => json(200, { ok: false }));
    const error = await rejection(createBotApi(TOKEN, fn).sendMessage({}));
    expect(error).not.toBeInstanceOf(BotApiError);
  });

  it('refuses an empty token', () => {
    expect(() => createBotApi(' ', fakeFetch(() => json(200, {})).fn)).toThrow(TypeError);
  });

  it('feeds the shared transport the error shape it classifies', async () => {
    const outcomes = [];
    for (const response of [
      () => json(200, { ok: true, result: {} }),
      () => json(403, { ok: false, error_code: 403, description: 'Forbidden' }),
      () => json(429, { ok: false, error_code: 429, description: 'Too Many Requests' }),
      () => json(400, { ok: false, error_code: 400, description: 'Bad Request' }),
      () => {
        throw new Error('network');
      },
    ]) {
      const transport = createTelegramBotTransport({
        api: createBotApi(TOKEN, fakeFetch(response).fn),
      });
      outcomes.push(
        await transport.deliver({
          kind: 'staff_alert',
          chatId: -1001234567890,
          orderNumber: '261031-7KQ2MX',
          status: 'NEW',
          previousStatus: null,
          totalUzs: 1000,
          cancelledByCustomer: false,
        }),
      );
    }
    expect(outcomes).toEqual([
      { outcome: 'delivered' },
      { outcome: 'recipient_blocked' },
      { outcome: 'retry', errorCode: 'bot_api_429' },
      { outcome: 'failed', errorCode: 'bot_api_400' },
      { outcome: 'retry', errorCode: 'transport_error' },
    ]);
  });
});
