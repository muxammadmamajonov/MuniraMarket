import { describe, expect, it } from 'vitest';
import { ORDER_ID_PATTERN, orderHref, ordersHref, parsePage, parseStatusFilter } from './orders';

describe('orders list URL helpers', () => {
  it('parses the status filter, ignoring unknown values', () => {
    expect(parseStatusFilter('NEW')).toBe('NEW');
    expect(parseStatusFilter('READY_FOR_DELIVERY')).toBe('READY_FOR_DELIVERY');
    expect(parseStatusFilter('new')).toBeNull();
    expect(parseStatusFilter('')).toBeNull();
    expect(parseStatusFilter(null)).toBeNull();
  });

  it('parses the page, defaulting to 1', () => {
    expect(parsePage('3')).toBe(3);
    for (const bad of [null, '', '0', '-2', '1.5', 'abc', '1e3x']) expect(parsePage(bad)).toBe(1);
  });

  it('builds links without default values', () => {
    expect(ordersHref('uz', { status: null, page: 1 })).toBe('/uz');
    expect(ordersHref('ru', { status: 'NEW', page: 1 })).toBe('/ru?status=NEW');
    expect(ordersHref('ru', { status: 'CANCELLED', page: 3 })).toBe('/ru?status=CANCELLED&page=3');
    expect(ordersHref('ru', { status: null, page: 2 })).toBe('/ru?page=2');
    expect(orderHref('uz', 'abc')).toBe('/uz/orders/abc');
  });

  it('only accepts UUID order ids', () => {
    expect(ORDER_ID_PATTERN.test('0b1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c11')).toBe(true);
    expect(ORDER_ID_PATTERN.test('../admin')).toBe(false);
    expect(ORDER_ID_PATTERN.test('123')).toBe(false);
  });
});
