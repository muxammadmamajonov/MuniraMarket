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

describe('createTelegramBotTransport: staff alerts', () => {
  const GROUP_ID = -1001234567890;
  const alert = (extra = {}) => ({
    kind: 'staff_alert',
    chatId: GROUP_ID,
    orderNumber: '261031-7KQ2MX',
    status: 'CANCELLED',
    previousStatus: 'CONFIRMED',
    totalUzs: 85000,
    cancelledByCustomer: true,
    ...extra,
  });

  it('sends one Uzbek HTML message to the group', async () => {
    const api = createRecordingApi();
    const result = await createTelegramBotTransport({ api }).deliver(
      alert({ recipientName: 'Demo <Mijoz>' }),
    );
    expect(result).toEqual({ outcome: 'delivered' });
    expect(api.calls).toHaveLength(1);
    const { params } = api.calls[0];
    expect(params.chat_id).toBe(GROUP_ID);
    expect(params.parse_mode).toBe('HTML');
    expect(params.text).toBe(
      [
        '<b>Buyurtma bekor qilindi №261031-7KQ2MX</b>',
        'Holat: Tasdiqlangan → Bekor qilingan',
        'Qabul qiluvchi: Demo &lt;Mijoz&gt;',
        `Jami: 85${NBSP}000${NBSP}so‘m`,
        '<i>Mijoz tomonidan bekor qilindi</i>',
      ].join('\n'),
    );
  });

  it('adds an "Adminda ochish" button when the admin origin is an https origin', async () => {
    const orderId = '00000000-0000-4000-8000-0000000000AB';
    for (const [adminOrigin, expected] of [
      [
        'https://admin.example.uz',
        'https://admin.example.uz/uz/orders/00000000-0000-4000-8000-0000000000ab',
      ],
      [
        'https://admin.example.uz/',
        'https://admin.example.uz/uz/orders/00000000-0000-4000-8000-0000000000ab',
      ],
      ['http://localhost:3001', null],
      ['https://admin.example.uz/path', null],
      [null, null],
    ]) {
      const api = createRecordingApi();
      await createTelegramBotTransport({ api, adminOrigin }).deliver(alert({ orderId }));
      const markup = api.calls[0].params.reply_markup;
      if (expected === null) expect(markup).toBeUndefined();
      else
        expect(markup).toEqual({ inline_keyboard: [[{ text: 'Adminda ochish', url: expected }]] });
    }
  });

  it('adds the Yandex Go courier button only when the alert has a destination', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api });
    const withDestination = alert({
      status: 'NEW',
      previousStatus: null,
      cancelledByCustomer: false,
      destination: { lat: 41.311081, lon: 69.240562 },
    });
    await expect(transport.deliver(withDestination)).resolves.toEqual({ outcome: 'delivered' });
    await expect(
      transport.deliver(alert({ status: 'NEW', previousStatus: null, cancelledByCustomer: false })),
    ).resolves.toEqual({ outcome: 'delivered' });
    expect(api.calls).toHaveLength(2);
    const [first, second] = api.calls.map((call) => call.params);
    expect(first.chat_id).toBe(GROUP_ID);
    expect(first.parse_mode).toBe('HTML');
    expect(first.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: 'Yandex chaqirish',
            url:
              'https://3.redirect.appmetrica.yandex.com/route?end-lat=41.311081&end-lon=69.240562' +
              '&tariffClass=courier&level=courier&ref=muniramarket' +
              '&appmetrica_tracking_id=1178268795219780156&lang=uz',
          },
        ],
      ],
    });
    // The coordinates never appear in the text itself.
    expect(first.text).not.toMatch(/41\.311|69\.240/);
    expect(second).not.toHaveProperty('reply_markup');
    expect(second.text).toBe(first.text);
  });

  it('sends the alert without a button when the destination is unusable', async () => {
    const api = createRecordingApi();
    const result = await createTelegramBotTransport({ api }).deliver(
      alert({ destination: { lat: 123, lon: 69.2 } }),
    );
    expect(result).toEqual({ outcome: 'delivered' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params).not.toHaveProperty('reply_markup');
  });

  it('maps 403 (bot removed from the group) to recipient_blocked', async () => {
    const api = throwing(new BotApiError(403, 'Forbidden: bot was kicked from the group chat'));
    await expect(createTelegramBotTransport({ api }).deliver(alert())).resolves.toEqual({
      outcome: 'recipient_blocked',
    });
  });

  it.each([
    [429, 'retry'],
    [500, 'retry'],
    [401, 'retry'],
    [400, 'failed'],
  ])('maps Bot API %i to %s', async (code, outcome) => {
    const api = throwing(new BotApiError(code, `chat ${GROUP_ID}`));
    await expect(createTelegramBotTransport({ api }).deliver(alert())).resolves.toEqual({
      outcome,
      errorCode: `bot_api_${code}`,
    });
  });

  it('maps network errors to retry transport_error', async () => {
    const api = throwing(new Error(`ECONNRESET ${GROUP_ID}`));
    await expect(createTelegramBotTransport({ api }).deliver(alert())).resolves.toEqual({
      outcome: 'retry',
      errorCode: 'transport_error',
    });
  });

  it.each([
    ['a positive (private) chat id', { chatId: 555 }],
    ['a non-integer chat id', { chatId: -1.5 }],
    ['an unknown status', { status: 'SHIPPED' }],
    ['an unknown previous status', { previousStatus: 'SHIPPED' }],
    ['a bad order number', { orderNumber: 'a b' }],
    ['a negative total', { totalUzs: -1 }],
  ])('fails with invalid_payload for %s without calling the API', async (_label, extra) => {
    const api = createRecordingApi();
    await expect(createTelegramBotTransport({ api }).deliver(alert(extra))).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'invalid_payload',
    });
    expect(api.calls).toHaveLength(0);
  });
});

describe('createTelegramBotTransport: shortage adjustments (ADR 0018)', () => {
  const change = { nameUz: 'Olma', nameRu: 'Яблоко', unit: 'kg', fromQuantity: 3, toQuantity: 1 };

  it('tells the customer in their language, as plain text', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api });
    const message = {
      kind: 'order_adjusted',
      chatId: 555,
      orderNumber: '261031-7KQ2MX',
      locale: 'ru',
      totalUzs: 23000,
      changes: [change],
    };
    await expect(transport.deliver(message)).resolves.toEqual({ outcome: 'delivered' });
    await transport.deliver({ ...message, locale: 'uz' });
    const [ru, uz] = api.calls.map((call) => call.params);
    expect(ru).toEqual({
      chat_id: 555,
      text: [
        'Ваш заказ изменён',
        'Заказ №261031-7KQ2MX',
        'К сожалению, некоторых товаров оказалось недостаточно:',
        `• Яблоко: 3${NBSP}кг → 1${NBSP}кг`,
        `Новая сумма: 23${NBSP}000${NBSP}сум`,
        '',
        'Если заказ больше не нужен, его можно отменить в приложении.',
      ].join('\n'),
    });
    expect(uz.text).toBe(
      [
        'Buyurtmangiz o‘zgardi',
        'Buyurtma №261031-7KQ2MX',
        'Afsuski, ba’zi mahsulotlar yetarli emas ekan:',
        `• Olma: 3${NBSP}kg → 1${NBSP}kg`,
        `Yangi jami: 23${NBSP}000${NBSP}so‘m`,
        '',
        'Buyurtma endi kerak bo‘lmasa, uni ilovada bekor qilishingiz mumkin.',
      ].join('\n'),
    );
  });

  it('maps a customer who blocked the bot to recipient_blocked', async () => {
    const api = throwing(new BotApiError(403, 'Forbidden: bot was blocked by the user'));
    const result = await createTelegramBotTransport({ api }).deliver({
      kind: 'order_adjusted',
      chatId: 555,
      orderNumber: '261031-7KQ2MX',
      locale: 'uz',
      totalUzs: 1,
      changes: [change],
    });
    expect(result).toEqual({ outcome: 'recipient_blocked' });
  });

  it('sends the staff group a short HTML alert with the reason and the admin button', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api, adminOrigin: 'https://admin.example.uz' });
    await transport.deliver({
      kind: 'staff_adjusted',
      chatId: -100500,
      orderId: '00000000-0000-4000-8000-000000000001',
      orderNumber: '261031-7KQ2MX',
      totalUzs: 23000,
      recipientName: 'Demo Mijoz',
      changes: [
        { nameUz: 'Olma', unit: 'kg', fromQuantity: 3, toQuantity: 1, markedOutOfStock: true },
      ],
      reason: 'Ikkitasi <ezilgan>',
    });
    expect(api.calls[0].params).toEqual({
      chat_id: -100500,
      parse_mode: 'HTML',
      text: [
        '<b>Buyurtma o‘zgartirildi №261031-7KQ2MX</b>',
        `Olma: 3${NBSP}kg → 1${NBSP}kg (omborda qolmadi)`,
        'Sabab: Ikkitasi &lt;ezilgan&gt;',
        'Qabul qiluvchi: Demo Mijoz',
        `<b>Yangi jami: 23${NBSP}000${NBSP}so‘m</b>`,
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Adminda ochish',
              url: 'https://admin.example.uz/uz/orders/00000000-0000-4000-8000-000000000001',
            },
          ],
        ],
      },
    });
  });

  it('fails an unusable adjustment permanently without calling the API', async () => {
    const api = createRecordingApi();
    const transport = createTelegramBotTransport({ api });
    const results = await Promise.all([
      transport.deliver({
        kind: 'order_adjusted',
        chatId: -5,
        orderNumber: '261031-7KQ2MX',
        locale: 'uz',
        totalUzs: 1,
        changes: [change],
      }),
      transport.deliver({
        kind: 'staff_adjusted',
        chatId: 555,
        orderNumber: '261031-7KQ2MX',
        totalUzs: 1,
        changes: [],
        reason: 'x',
      }),
    ]);
    expect(results).toEqual([
      { outcome: 'failed', errorCode: 'invalid_payload' },
      { outcome: 'failed', errorCode: 'invalid_payload' },
    ]);
    expect(api.calls).toHaveLength(0);
  });
});
