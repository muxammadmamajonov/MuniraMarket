import { describe, expect, it } from 'vitest';
import { formatDateTime } from './date';
import { formatPlural } from './format';
import { getDictionary } from './index';

describe('formatPlural', () => {
  const ru = getDictionary('ru').orders.items;
  const uz = getDictionary('uz').orders.items;

  it.each([
    [0, '0 товаров'],
    [1, '1 товар'],
    [2, '2 товара'],
    [4, '4 товара'],
    [5, '5 товаров'],
    [11, '11 товаров'],
    [12, '12 товаров'],
    [21, '21 товар'],
    [22, '22 товара'],
    [99, '99 товаров'],
    [101, '101 товар'],
  ])('Russian %i -> %s', (count, expected) => {
    expect(formatPlural(ru, count, 'ru')).toBe(expected);
  });

  it('Uzbek never inflects the noun', () => {
    for (const count of [0, 1, 2, 5, 21, 99]) {
      expect(formatPlural(uz, count, 'uz')).toBe(`${String(count)} ta mahsulot`);
    }
  });
});

describe('formatDateTime', () => {
  it('shows Asia/Tashkent time (UTC+5), including the date rolling over', () => {
    expect(formatDateTime('2026-10-31T21:30:00Z')).toBe('01.11.2026 02:30');
    expect(formatDateTime('2026-03-01T00:00:00Z')).toBe('01.03.2026 05:00');
  });

  it('accepts API timestamps with an offset and zero-pads', () => {
    expect(formatDateTime('2026-01-05T04:07:00+00:00')).toBe('05.01.2026 09:07');
    expect(formatDateTime('2026-01-05T00:00:00+05:00')).toBe('05.01.2026 00:00');
  });

  it('is independent of the machine time zone and never says 24:00', () => {
    expect(formatDateTime('2026-06-30T19:00:00Z')).toBe('01.07.2026 00:00');
  });

  it('returns an empty string for garbage instead of "Invalid Date"', () => {
    expect(formatDateTime('not a date')).toBe('');
  });
});
