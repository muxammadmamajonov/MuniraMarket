import { describe, expect, it } from 'vitest';
import { BotApiError } from 'sdk';
import {
  buildOrderStatusMessage,
  formatUzs,
  sendOrderStatusNotification,
} from '../tgcloud/lib/notifications/orderStatus.js';
import { MESSAGES, ORDER_STATUSES, messagesFor, pickLocale } from '../tgcloud/lib/i18n.js';
import { createRecordingApi } from './sdk-fake/api.js';

const NBSP = ' ';

describe('i18n', () => {
  it('pickLocale maps ru to ru and everything else to uz', () => {
    expect(pickLocale('ru')).toBe('ru');
    expect(pickLocale('ru-RU')).toBe('ru');
    expect(pickLocale('RU')).toBe('ru');
    for (const code of ['uz', 'en', 'tr', '', undefined, null]) expect(pickLocale(code)).toBe('uz');
  });

  it('has complete uz and ru strings, including all 7 statuses', () => {
    expect([...ORDER_STATUSES]).toEqual([
      'NEW',
      'CONFIRMED',
      'PICKING',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'CANCELLED',
    ]);
    for (const locale of ['uz', 'ru']) {
      const m = messagesFor(locale);
      for (const key of ['startGreeting', 'openShop', 'genericError'])
        expect(m[key].length).toBeGreaterThan(0);
      for (const status of ORDER_STATUSES) expect(m.orderStatus[status].length).toBeGreaterThan(0);
    }
    expect(Object.keys(MESSAGES.uz.orderStatus)).toEqual(Object.keys(MESSAGES.ru.orderStatus));
    expect(MESSAGES.uz.startGreeting).toContain('MuniraMarket');
    expect(MESSAGES.ru.startGreeting).toContain('MuniraMarket');
  });
});

describe('formatUzs', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, `1${NBSP}000`],
    [12500, `12${NBSP}500`],
    [1234567, `1${NBSP}234${NBSP}567`],
  ])('formats %i', (n, expected) => {
    expect(formatUzs(n)).toBe(expected);
  });

  it.each([-1, 1.5, NaN, Infinity, '100'])('rejects %j', (value) => {
    expect(() => formatUzs(value)).toThrow(TypeError);
  });
});

describe('buildOrderStatusMessage', () => {
  it('formats uz with so‘m and U+00A0 grouping', () => {
    const { text } = buildOrderStatusMessage({
      orderNumber: 'MM-1001',
      status: 'CONFIRMED',
      locale: 'uz',
      totalUzs: 1234500,
    });
    expect(text).toBe(
      [
        'Buyurtmangiz tasdiqlandi',
        'Buyurtma №MM-1001',
        `Jami: 1${NBSP}234${NBSP}500${NBSP}so‘m`,
      ].join('\n'),
    );
  });

  it('formats ru with сум', () => {
    const { text } = buildOrderStatusMessage({
      orderNumber: '42',
      status: 'OUT_FOR_DELIVERY',
      locale: 'ru',
      totalUzs: 85000,
    });
    expect(text).toBe(
      ['Ваш заказ в пути', 'Заказ №42', `Итого: 85${NBSP}000${NBSP}сум`].join('\n'),
    );
  });

  it('renders every status in both locales, falling back to uz for unknown locales', () => {
    for (const status of ORDER_STATUSES) {
      for (const locale of ['uz', 'ru']) {
        expect(buildOrderStatusMessage({ orderNumber: '1', status, locale }).text).toContain(
          MESSAGES[locale].orderStatus[status],
        );
      }
    }
    expect(
      buildOrderStatusMessage({ orderNumber: '1', status: 'NEW', locale: 'en' }).text,
    ).toContain(MESSAGES.uz.orderStatus.NEW);
  });

  it('omits the total when not provided', () => {
    expect(
      buildOrderStatusMessage({ orderNumber: '1', status: 'NEW', locale: 'ru' }).text.split('\n'),
    ).toHaveLength(2);
  });

  it('shows a sanitised cancel reason only for CANCELLED', () => {
    const cancelled = buildOrderStatusMessage({
      orderNumber: '7',
      status: 'CANCELLED',
      locale: 'uz',
      cancelReason: '  Mahsulot\n\n tugadi\t<b>x</b> ',
    });
    expect(cancelled.text.split('\n').at(-1)).toBe('Sabab: Mahsulot tugadi <b>x</b>');
    expect(cancelled.text.split('\n')).toHaveLength(3);

    const delivered = buildOrderStatusMessage({
      orderNumber: '7',
      status: 'DELIVERED',
      locale: 'uz',
      cancelReason: 'x',
    });
    expect(delivered.text).not.toContain('Sabab');

    const long = buildOrderStatusMessage({
      orderNumber: '7',
      status: 'CANCELLED',
      locale: 'ru',
      cancelReason: 'я'.repeat(500),
    });
    expect(Array.from(long.text.split('\n').at(-1)).length).toBeLessThanOrEqual(
      'Причина: '.length + 200,
    );
  });

  it('rejects unknown statuses and malformed numbers', () => {
    expect(() => buildOrderStatusMessage({ orderNumber: '1', status: 'SHIPPED' })).toThrow(
      /Unknown order status/,
    );
    expect(() => buildOrderStatusMessage({ orderNumber: '1', status: 'new' })).toThrow(TypeError);
    expect(() => buildOrderStatusMessage({ orderNumber: '', status: 'NEW' })).toThrow(TypeError);
    expect(() => buildOrderStatusMessage({ orderNumber: 'a b', status: 'NEW' })).toThrow(TypeError);
    expect(() =>
      buildOrderStatusMessage({ orderNumber: '1', status: 'NEW', totalUzs: -5 }),
    ).toThrow(TypeError);
  });
});

describe('sendOrderStatusNotification', () => {
  it('sends plain text (no parse_mode) via api.sendMessage', async () => {
    const api = createRecordingApi();
    const result = await sendOrderStatusNotification({
      api,
      chatId: 123,
      orderNumber: '9',
      status: 'DELIVERED',
      locale: 'ru',
      totalUzs: 1000,
    });
    expect(result).toMatchObject({ delivered: true });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params).toEqual({
      chat_id: 123,
      text: `Ваш заказ доставлен\nЗаказ №9\nИтого: 1${NBSP}000${NBSP}сум`,
    });
    expect(api.calls[0].params).not.toHaveProperty('parse_mode');
  });

  it('returns { delivered: false, reason: "blocked" } when the user blocked the bot (403)', async () => {
    const api = createRecordingApi();
    api.respond('sendMessage', () => {
      throw new BotApiError(403, 'Forbidden: bot was blocked by the user', {
        method: 'sendMessage',
      });
    });
    await expect(
      sendOrderStatusNotification({
        api,
        chatId: 123,
        orderNumber: '9',
        status: 'NEW',
        locale: 'uz',
      }),
    ).resolves.toEqual({ delivered: false, reason: 'blocked' });
  });

  it('rethrows other Bot API errors (e.g. 429) and unknown errors', async () => {
    const api = createRecordingApi();
    api.respond('sendMessage', () => {
      throw new BotApiError(429, 'Too Many Requests', {
        method: 'sendMessage',
        parameters: { retry_after: 3 },
      });
    });
    await expect(
      sendOrderStatusNotification({ api, chatId: 123, orderNumber: '9', status: 'NEW' }),
    ).rejects.toMatchObject({ code: 429 });

    api.respond('sendMessage', () => {
      throw new Error('boom');
    });
    await expect(
      sendOrderStatusNotification({ api, chatId: 123, orderNumber: '9', status: 'NEW' }),
    ).rejects.toThrow('boom');
  });

  it('validates input before calling the API', async () => {
    const api = createRecordingApi();
    await expect(
      sendOrderStatusNotification({ api, chatId: 0, orderNumber: '9', status: 'NEW' }),
    ).rejects.toThrow(TypeError);
    await expect(
      sendOrderStatusNotification({ api, chatId: 1, orderNumber: '9', status: 'BOGUS' }),
    ).rejects.toThrow(TypeError);
    expect(api.calls).toHaveLength(0);
  });
});
