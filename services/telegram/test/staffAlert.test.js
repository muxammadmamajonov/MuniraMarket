import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../tgcloud/lib/i18n.js';
import { buildStaffAlertMessage } from '../tgcloud/lib/notifications/staffAlert.js';

const NBSP = ' ';
const input = (extra = {}) => ({
  orderNumber: '261031-7KQ2MX',
  status: 'NEW',
  previousStatus: null,
  totalUzs: 1250000,
  cancelledByCustomer: false,
  ...extra,
});

describe('buildStaffAlertMessage', () => {
  it('builds an Uzbek block, a blank line, then a Russian block for a new order', () => {
    expect(buildStaffAlertMessage(input()).text).toBe(
      [
        'Yangi buyurtma №261031-7KQ2MX',
        'Holat: Yangi',
        `Jami: 1${NBSP}250${NBSP}000${NBSP}so‘m`,
        '',
        'Новый заказ №261031-7KQ2MX',
        'Статус: Новый',
        `Итого: 1${NBSP}250${NBSP}000${NBSP}сум`,
      ].join('\n'),
    );
  });

  it.each([
    ['OUT_FOR_DELIVERY', 'Buyurtma yetkazishga chiqdi', 'Заказ передан в доставку'],
    ['DELIVERED', 'Buyurtma yetkazildi', 'Заказ доставлен'],
    ['CANCELLED', 'Buyurtma bekor qilindi', 'Заказ отменён'],
    ['CONFIRMED', 'Buyurtma holati o‘zgardi', 'Статус заказа изменён'],
  ])('uses a headline for %s in both languages', (status, uz, ru) => {
    const { text } = buildStaffAlertMessage(input({ status }));
    const [uzBlock, ruBlock] = text.split('\n\n');
    expect(uzBlock.startsWith(`${uz} №`)).toBe(true);
    expect(ruBlock.startsWith(`${ru} №`)).toBe(true);
  });

  it('shows the transition when the previous status is known', () => {
    const { text } = buildStaffAlertMessage(
      input({ status: 'OUT_FOR_DELIVERY', previousStatus: 'READY_FOR_DELIVERY' }),
    );
    expect(text).toContain('Holat: Yetkazishga tayyor → Yo‘lda');
    expect(text).toContain('Статус: Готов к доставке → В пути');
  });

  it('notes a customer cancellation in both languages only when flagged', () => {
    const flagged = buildStaffAlertMessage(
      input({ status: 'CANCELLED', previousStatus: 'NEW', cancelledByCustomer: true }),
    ).text;
    expect(flagged).toContain('Mijoz tomonidan bekor qilindi');
    expect(flagged).toContain('Отменён клиентом');
    const staff = buildStaffAlertMessage(input({ status: 'CANCELLED' })).text;
    expect(staff).not.toContain('Mijoz');
    expect(staff).not.toContain('клиентом');
  });

  it('has a label for every status in both languages', () => {
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
