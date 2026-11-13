import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../tgcloud/lib/i18n.js';
import {
  TELEGRAM_TEXT_LIMIT,
  buildStaffAdjustedMessage,
  buildStaffAlertMessage,
  escapeHtml,
  tashkentDateTime,
} from '../tgcloud/lib/notifications/staffAlert.js';

const NBSP = '\u00a0';
const input = (extra = {}) => ({
  orderNumber: '261031-7KQ2MX',
  status: 'NEW',
  previousStatus: null,
  totalUzs: 1250000,
  cancelledByCustomer: false,
  ...extra,
});

const details = (extra = {}) => ({
  items: [
    { nameUz: 'Olma', quantity: 2, unit: 'kg', lineTotalUzs: 30000 },
    { nameUz: 'Non <issiq>', quantity: 3, unit: 'piece', lineTotalUzs: 12000 },
  ],
  subtotalUzs: 42000,
  paymentMethod: 'cash_on_delivery',
  recipientPhone: '+998001234567',
  address: {
    street: 'Amir Temur ko‘chasi',
    house: '15',
    apartment: '12',
    entrance: '2',
    floor: '3',
    landmark: 'Korzinka & bank yonida',
  },
  comment: 'Eshik qo‘ng‘irog‘i\nishlamaydi',
  createdAt: '2026-11-13T10:05:00.123456+00:00',
  ...extra,
});

describe('buildStaffAlertMessage: a new order with its details', () => {
  it('shows the whole order in Uzbek HTML, every value escaped', () => {
    const message = buildStaffAlertMessage(
      input({ totalUzs: 42000, recipientName: 'Aziz <Karimov>', details: details() }),
    );
    expect(message.parseMode).toBe('HTML');
    expect(message.text).toBe(
      [
        '<b>Yangi buyurtma №261031-7KQ2MX</b>',
        'Vaqti: 13.11.2026 15:05',
        '',
        '<b>Mahsulotlar:</b>',
        `1. Olma — 2${NBSP}kg — 30${NBSP}000${NBSP}so‘m`,
        `2. Non &lt;issiq&gt; — 3${NBSP}dona — 12${NBSP}000${NBSP}so‘m`,
        '',
        `<b>Jami: 42${NBSP}000${NBSP}so‘m</b>`,
        'To‘lov: Naqd pul, qabul qilganda',
        '',
        '<b>Qabul qiluvchi:</b> Aziz &lt;Karimov&gt;',
        '<b>Telefon:</b> +998001234567',
        '<b>Manzil:</b> Amir Temur ko‘chasi, 15-uy, 12-xonadon, 2-podyezd, 3-qavat',
        '<b>Mo‘ljal:</b> Korzinka &amp; bank yonida',
        '<b>Izoh:</b> Eshik qo‘ng‘irog‘i\nishlamaydi',
      ].join('\n'),
    );
  });

  it('shows the subtotal only when it differs from the total, and skips empty parts', () => {
    const { text } = buildStaffAlertMessage(
      input({
        totalUzs: 57000,
        details: details({
          paymentMethod: 'card_on_delivery',
          address: {
            street: 'Demo',
            house: '1',
            apartment: null,
            entrance: '',
            floor: null,
            landmark: null,
          },
          comment: null,
          createdAt: 'not a date',
        }),
      }),
    );
    expect(text).toContain(`Mahsulotlar summasi: 42${NBSP}000${NBSP}so‘m`);
    expect(text).toContain(`<b>Jami: 57${NBSP}000${NBSP}so‘m</b>`);
    expect(text).toContain('To‘lov: Karta orqali, qabul qilganda');
    expect(text.endsWith('<b>Manzil:</b> Demo, 1-uy')).toBe(true);
    expect(text).not.toContain('Vaqti');
    expect(text).not.toContain('Mo‘ljal');
    expect(text).not.toContain('Izoh');
    expect(text).not.toContain('Qabul qiluvchi');
  });

  it('cuts a long item list with "+N ta mahsulot" to stay within 4096 characters', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      nameUz: `${'Juda uzun mahsulot nomi '.repeat(10)}${index}`,
      quantity: 1,
      unit: 'piece',
      lineTotalUzs: 1000,
    }));
    const { text } = buildStaffAlertMessage(
      input({
        recipientName: 'R'.repeat(100),
        details: details({ items, comment: 'c'.repeat(500) }),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    const shown = text.split('\n').filter((line) => /^\d+\. /.test(line)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(50);
    expect(text).toContain(`<i>+${50 - shown} ta mahsulot</i>`);
    // Everything after the list is still there.
    expect(text).toContain('<b>Izoh:</b>');
  });

  it('caps and collapses free text', () => {
    const { text } = buildStaffAlertMessage(
      input({
        recipientName: '  Aziz\u0000\n  Karimov ',
        details: details({ comment: `${'x'.repeat(600)}` }),
      }),
    );
    expect(text).toContain('<b>Qabul qiluvchi:</b> Aziz Karimov\n');
    expect(text).toContain(`<b>Izoh:</b> ${'x'.repeat(499)}…`);
  });
});

describe('buildStaffAlertMessage: short alerts', () => {
  it('a new order without details (an older payload) gets the short form', () => {
    expect(buildStaffAlertMessage(input()).text).toBe(
      [
        '<b>Yangi buyurtma №261031-7KQ2MX</b>',
        'Holat: Yangi',
        `Jami: 1${NBSP}250${NBSP}000${NBSP}so‘m`,
      ].join('\n'),
    );
  });

  it.each([
    ['OUT_FOR_DELIVERY', 'Buyurtma yetkazishga chiqdi'],
    ['DELIVERED', 'Buyurtma yetkazildi'],
    ['CANCELLED', 'Buyurtma bekor qilindi'],
    ['CONFIRMED', 'Buyurtma holati o‘zgardi'],
  ])('uses a headline for %s', (status, headline) => {
    const { text } = buildStaffAlertMessage(input({ status, recipientName: 'Demo Mijoz' }));
    expect(text.startsWith(`<b>${headline} №261031-7KQ2MX</b>\n`)).toBe(true);
    expect(text).toContain('Qabul qiluvchi: Demo Mijoz');
  });

  it('shows the transition when the previous status is known', () => {
    const { text } = buildStaffAlertMessage(
      input({ status: 'OUT_FOR_DELIVERY', previousStatus: 'READY_FOR_DELIVERY' }),
    );
    expect(text).toContain('Holat: Yetkazishga tayyor → Yo‘lda');
  });

  it('notes a customer cancellation only when flagged', () => {
    const flagged = buildStaffAlertMessage(
      input({ status: 'CANCELLED', previousStatus: 'NEW', cancelledByCustomer: true }),
    ).text;
    expect(flagged).toContain('<i>Mijoz tomonidan bekor qilindi</i>');
    const staff = buildStaffAlertMessage(input({ status: 'CANCELLED' })).text;
    expect(staff).not.toContain('Mijoz');
  });

  it('never shows details on a status other than NEW', () => {
    const { text } = buildStaffAlertMessage(input({ status: 'DELIVERED', details: details() }));
    expect(text).not.toContain('Mahsulotlar');
    expect(text).not.toContain('+998');
  });

  it('has a label for every status', () => {
    for (const status of ORDER_STATUSES) {
      const { text } = buildStaffAlertMessage(input({ status, previousStatus: 'NEW' }));
      expect(text).not.toMatch(/undefined/);
    }
  });

  it.each([
    ['unknown status', { status: 'SHIPPED' }],
    ['unknown previous status', { previousStatus: 'SHIPPED' }],
    ['bad order number', { orderNumber: '<b>x</b>' }],
    ['negative total', { totalUzs: -5 }],
    ['fractional total', { totalUzs: 1.5 }],
  ])('throws TypeError for %s', (_label, extra) => {
    expect(() => buildStaffAlertMessage(input(extra))).toThrow(TypeError);
  });
});

describe('buildStaffAdjustedMessage', () => {
  it('lists the lowered lines, the reason, the recipient and the new total', () => {
    const message = buildStaffAdjustedMessage({
      orderNumber: '261031-7KQ2MX',
      totalUzs: 15000,
      recipientName: 'Demo Mijoz',
      changes: [
        { nameUz: 'Olma', unit: 'kg', fromQuantity: 2, toQuantity: 0, markedOutOfStock: true },
        { nameUz: 'Non', unit: 'piece', fromQuantity: 3, toQuantity: 2, markedOutOfStock: false },
      ],
      reason: 'Javonda <qolmadi>',
    });
    expect(message).toEqual({
      parseMode: 'HTML',
      text: [
        '<b>Buyurtma o‘zgartirildi №261031-7KQ2MX</b>',
        `Olma: 2${NBSP}kg → 0${NBSP}kg (omborda qolmadi)`,
        `Non: 3${NBSP}dona → 2${NBSP}dona`,
        'Sabab: Javonda &lt;qolmadi&gt;',
        'Qabul qiluvchi: Demo Mijoz',
        `<b>Yangi jami: 15${NBSP}000${NBSP}so‘m</b>`,
      ].join('\n'),
    });
  });
});

describe('helpers', () => {
  it('escapeHtml escapes markup characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it.each([
    ['2026-11-13T10:05:00.123456+00:00', '13.11.2026 15:05'],
    ['2026-12-31T19:30:00Z', '01.01.2027 00:30'],
    ['nonsense', null],
    [null, null],
  ])('tashkentDateTime(%j)', (iso, expected) => {
    expect(tashkentDateTime(iso)).toBe(expected);
  });
});
