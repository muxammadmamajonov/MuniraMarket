import { describe, expect, it } from 'vitest';
import type { LineFacts } from '../../../src/domain/cart.ts';
import { buildQuote, normalizeUzPhone } from '../../../src/domain/checkout.ts';
import { tashkentDate, tashkentInstant } from '../../../src/domain/tashkentTime.ts';
import {
  NUMBER_ALPHABET,
  coordinatesOf,
  newOrderNumber,
} from '../../../src/repositories/orders.ts';

const line = (priceUzs: number, quantity: number, extra: Partial<LineFacts> = {}): LineFacts => ({
  priceUzs,
  quantity,
  isAvailable: true,
  stockQuantity: null,
  ...extra,
});

const utc = (iso: string): number => Date.parse(iso) / 1000;

describe('Tashkent time', () => {
  it('computes the local date and instants', () => {
    expect(tashkentDate(utc('2026-10-31T18:59:59Z'))).toBe('2026-10-31');
    expect(tashkentDate(utc('2026-10-31T19:00:00Z'))).toBe('2026-11-01');
    expect(tashkentInstant('2026-11-01', '10:00:00')).toBe(utc('2026-11-01T05:00:00Z'));
    expect(tashkentInstant('2026-11-01', '00:00')).toBe(utc('2026-10-31T19:00:00Z'));
  });
});

describe('quote', () => {
  it('charges nothing for delivery: the total is the subtotal', () => {
    const quote = buildQuote([line(30_000, 2), line(5_000, 1)]);
    expect([quote.subtotalUzs, quote.totalUzs]).toEqual([65_000, 65_000]);
    expect(quote.issues).toEqual([]);
    expect(quote.canPlaceOrder).toBe(true);
    // No minimum order: a single cheap line can be ordered.
    expect(buildQuote([line(1, 1)]).canPlaceOrder).toBe(true);
    expect(Object.keys(quote).sort()).toEqual(
      ['canPlaceOrder', 'cart', 'issues', 'lines', 'subtotalUzs', 'totalUzs'].sort(),
    );
  });

  it('reports an empty cart', () => {
    const quote = buildQuote([]);
    expect(quote.issues).toEqual(['cart_empty']);
    expect(quote.canPlaceOrder).toBe(false);
    expect([quote.subtotalUzs, quote.totalUzs]).toEqual([0, 0]);
  });

  it('excludes lines with issues and blocks the order', () => {
    const quote = buildQuote([
      line(60_000, 1),
      line(10_000, 2, { isAvailable: false }),
      line(5_000, 3, { stockQuantity: 1 }),
    ]);
    expect([quote.subtotalUzs, quote.totalUzs]).toEqual([60_000, 60_000]);
    expect(quote.issues).toEqual(['cart_has_issues']);
    expect(quote.canPlaceOrder).toBe(false);
    expect(quote.lines.map((l) => l.issue)).toEqual([
      null,
      'product_inactive',
      'insufficient_stock',
    ]);
    const onlyInvalid = buildQuote([line(60_000, 1, { isAvailable: false })]);
    expect(onlyInvalid.issues).toEqual(['cart_has_issues']);
    expect(onlyInvalid.totalUzs).toBe(0);
  });
});

describe('address coordinates', () => {
  it('reads lat/lon from a snapshot, null for pre-coordinate orders', () => {
    expect(coordinatesOf({ lat: 41.311081, lon: 69.240562, street: 'x' })).toEqual({
      lat: 41.311081,
      lon: 69.240562,
    });
    expect(coordinatesOf({ area: 'old-client', street: 'x', house: '1' })).toBeNull();
    expect(coordinatesOf({ lat: '41.3', lon: 69.2 })).toBeNull();
    expect(coordinatesOf({ lat: 41.3 })).toBeNull();
    expect(coordinatesOf({ lat: null, lon: null })).toBeNull();
    expect(coordinatesOf({ lat: 91, lon: 69.2 })).toBeNull();
    expect(coordinatesOf({ lat: 41.3, lon: -180.5 })).toBeNull();
    expect(coordinatesOf({ lat: true, lon: 69.2 })).toBeNull();
    expect(coordinatesOf({ lat: -90, lon: 180 })).toEqual({ lat: -90, lon: 180 });
  });
});

describe('phone numbers', () => {
  it('normalizes Uzbekistan numbers', () => {
    for (const raw of [
      '+998001234567',
      '+998 00 123-45-67',
      '+998 (00) 123 45 67',
      '+998\t00 1234567',
    ]) {
      expect(normalizeUzPhone(raw)).toBe('+998001234567');
    }
  });

  it('rejects anything else', () => {
    for (const raw of [
      '998001234567',
      '+99800123456',
      '+9980012345678',
      '+7 900 123 45 67',
      '+998００1234567',
      '',
    ]) {
      expect(() => normalizeUzPhone(raw)).toThrow(RangeError);
    }
  });
});

describe('order numbers', () => {
  it('use the Tashkent date and the look-alike-free alphabet', () => {
    const number = newOrderNumber(utc('2026-10-31T19:30:00Z'));
    expect(number).toMatch(/^261101-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(newOrderNumber(utc('2026-10-31T10:00:00Z'), () => 0)).toBe(
      `261031-${NUMBER_ALPHABET[0]!.repeat(6)}`,
    );
  });
});
