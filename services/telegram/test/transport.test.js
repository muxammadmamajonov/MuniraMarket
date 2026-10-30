import { describe, expect, it } from 'vitest';
import { BotApiError } from 'sdk';
import { createTelegramBotTransport } from '../tgcloud/lib/notifications/transport.js';
import { createRecordingApi } from './sdk-fake/api.js';

const NBSP = '\u00a0';
const notification = (extra = {}) => ({
  chatId: 555,
  orderNumber: '261031-7KQ2MX',
  status: 'CONFIRMED',
  locale: 'ru',
  totalUzs: 85000,
  ...extra,
});

function throwing(error) {
  const api = createRecordingApi();
  api.respond('sendMessage', () => {
    throw error;
  });
  return api;
}

describe('createTelegramBotTransport', () => {
  it('delivers through api.sendMessage as plain text', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api });
    await expect(transport.deliver(notification())).resolves.toEqual({ outcome: 'delivered' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params).toEqual({
      chat_id: 555,
      text: `Ваш заказ подтверждён\nЗаказ №261031-7KQ2MX\nИтого: 85${NBSP}000${NBSP}сум`,
    });
    expect(api.calls[0].params).not.toHaveProperty('parse_mode');
  });

  it('maps a blocked bot (403) to recipient_blocked without an error code', async () => {
    const api = throwing(new BotApiError(403, 'Forbidden: bot was blocked by the user'));
    const result = await createTelegramBotTransport({ api }).deliver(notification());
    expect(result).toEqual({ outcome: 'recipient_blocked' });
  });

  it.each([401, 429, 500, 502, 503, 504])('maps Bot API %i to retry bot_api_%i', async (code) => {
    const api = throwing(new BotApiError(code, 'secret description 555'));
    const result = await createTelegramBotTransport({ api }).deliver(notification());
    expect(result).toEqual({ outcome: 'retry', errorCode: `bot_api_${code}` });
  });

  it.each([400, 404, 409])('maps other 4xx (%i) to failed bot_api_%i', async (code) => {
    const api = throwing(new BotApiError(code, 'Bad Request: chat not found'));
    const result = await createTelegramBotTransport({ api }).deliver(notification());
    expect(result).toEqual({ outcome: 'failed', errorCode: `bot_api_${code}` });
  });

  it('maps network and unexpected errors to retry transport_error', async () => {
    for (const error of [new Error('ECONNRESET 555'), new TypeError('sdk blew up'), 'string']) {
      const result = await createTelegramBotTransport({ api: throwing(error) }).deliver(
        notification(),
      );
      expect(result).toEqual({ outcome: 'retry', errorCode: 'transport_error' });
    }
    // A BotApiError without a usable status code is not classifiable either.
    const odd = throwing(Object.assign(new BotApiError(200, 'x'), { code: 'nope' }));
    await expect(createTelegramBotTransport({ api: odd }).deliver(notification())).resolves.toEqual(
      { outcome: 'retry', errorCode: 'transport_error' },
    );
  });

  it.each([
    ['unknown status', { status: 'SHIPPED' }],
    ['bad order number', { orderNumber: 'a b' }],
    ['negative total', { totalUzs: -1 }],
    ['fractional total', { totalUzs: 1.5 }],
    ['zero chat', { chatId: 0 }],
    ['negative chat', { chatId: -5 }],
    ['non-integer chat', { chatId: 1.5 }],
    ['string chat', { chatId: '555' }],
  ])(
    'fails permanently with invalid_payload for %s, without calling the API',
    async (_n, extra) => {
      const api = createRecordingApi();
      const result = await createTelegramBotTransport({ api }).deliver(notification(extra));
      expect(result).toEqual({ outcome: 'failed', errorCode: 'invalid_payload' });
      expect(api.calls).toHaveLength(0);
    },
  );

  it('fails with invalid_payload for a non-object notification', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api });
    for (const bad of [null, undefined, 42]) {
      await expect(transport.deliver(bad)).resolves.toEqual({
        outcome: 'failed',
        errorCode: 'invalid_payload',
      });
    }
  });

  it('never puts message text, chat ids or descriptions into error codes', async () => {
    const cases = [
      new BotApiError(429, 'Too Many Requests: retry after 5 for chat 555'),
      new BotApiError(400, 'Bad Request: 261031-7KQ2MX'),
      new Error('chat 555'),
    ];
    for (const error of cases) {
      const result = await createTelegramBotTransport({ api: throwing(error) }).deliver(
        notification({ cancelReason: 'Mahsulot tugadi' }),
      );
      expect(result.errorCode).toMatch(/^[a-z0-9_.-]{1,64}$/);
      expect(JSON.stringify(result)).not.toMatch(/555|261031|tugadi|Request/);
    }
  });
});
