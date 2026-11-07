import { describe, expect, it } from 'vitest';
import type { LineFacts } from '../../../src/domain/cart.ts';
import { buildQuote, normalizeUzPhone } from '../../../src/domain/checkout.ts';
import {
  DISTRICT_CODES,
  DISTRICT_NAMES,
  deliveryFeeFor,
  freeDeliveryRemaining,
  isOpenAt,
  matchZone,
  slotCutoffIsValid,
  tashkentDate,
  tashkentInstant,
  type ZoneRules,
} from '../../../src/domain/delivery.ts';
import { NUMBER_ALPHABET, newOrderNumber } from '../../../src/repositories/orders.ts';

const RULES: ZoneRules = {
  deliveryFeeUzs: 15_000,
  freeDeliveryThresholdUzs: 300_000,
  minOrderUzs: 50_000,
  opensAt: '09:00:00',
  closesAt: '21:00:00',
};

const line = (priceUzs: number, quantity: number, extra: Partial<LineFacts> = {}): LineFacts => ({
  priceUzs,
  quantity,
  isAvailable: true,
  stockQuantity: null,
  ...extra,
});

const utc = (iso: string): number => Date.parse(iso) / 1000;

describe('delivery zones (port of test_checkout_domain.py)', () => {
  it('has twelve districts each with both names', () => {
    expect(DISTRICT_CODES).toHaveLength(12);
    for (const code of DISTRICT_CODES) {
      expect(DISTRICT_NAMES[code].uz).not.toBe('');
      expect(DISTRICT_NAMES[code].ru).not.toBe('');
    }
  });

  it('matches the active zone for a district and ignores inactive ones', () => {
    const zones = [
      { name: 'closed', isActive: false, districts: new Set(['chilonzor']) },
      { name: 'open', isActive: true, districts: new Set(['chilonzor', 'olmazor']) },
    ];
    expect(matchZone('chilonzor', zones)?.name).toBe('open');
    expect(matchZone('bektemir', zones)).toBeNull();
  });

  it('prices delivery around the threshold', () => {
    expect([deliveryFeeFor(RULES, 299_999), freeDeliveryRemaining(RULES, 299_999)]).toEqual([
      15_000, 1,
    ]);
    expect([deliveryFeeFor(RULES, 300_000), freeDeliveryRemaining(RULES, 300_000)]).toEqual([0, 0]);
    const never = { ...RULES, freeDeliveryThresholdUzs: null };
    expect([deliveryFeeFor(never, 10_000_000), freeDeliveryRemaining(never, 1)]).toEqual([
      15_000,
      null,
    ]);
    const always = { ...RULES, freeDeliveryThresholdUzs: 0 };
    expect(deliveryFeeFor(always, 0)).toBe(0);
  });

  it('checks opening hours in Tashkent time, closing time exclusive', () => {
    expect(isOpenAt(RULES, utc('2026-10-31T03:59:59Z'))).toBe(false); // 08:59:59
    expect(isOpenAt(RULES, utc('2026-10-31T04:00:00Z'))).toBe(true); // 09:00
    expect(isOpenAt(RULES, utc('2026-10-31T15:59:59Z'))).toBe(true); // 20:59:59
    expect(isOpenAt(RULES, utc('2026-10-31T16:00:00Z'))).toBe(false); // 21:00
  });

  it('computes the local date and instants', () => {
    expect(tashkentDate(utc('2026-10-31T18:59:59Z'))).toBe('2026-10-31');
    expect(tashkentDate(utc('2026-10-31T19:00:00Z'))).toBe('2026-11-01');
    expect(tashkentInstant('2026-11-01', '10:00:00')).toBe(utc('2026-11-01T05:00:00Z'));
    expect(slotCutoffIsValid('2026-11-01', '10:00:00', utc('2026-11-01T05:00:00Z'))).toBe(true);
    expect(slotCutoffIsValid('2026-11-01', '10:00:00', utc('2026-11-01T05:00:01Z'))).toBe(false);
  });
});

describe('quote', () => {
  it('adds the fee to the subtotal and is free at the threshold', () => {
    const quote = buildQuote([line(30_000, 2)], RULES);
    expect([quote.subtotalUzs, quote.deliveryFeeUzs, quote.totalUzs]).toEqual([
      60_000, 15_000, 75_000,
    ]);
    expect(quote.canPlaceOrder).toBe(true);
    expect(buildQuote([line(150_000, 2)], RULES).deliveryFeeUzs).toBe(0);
  });

  it('reports an empty cart', () => {
    const quote = buildQuote([], RULES);
    expect(quote.issues).toEqual(['cart_empty']);
    expect(quote.canPlaceOrder).toBe(false);
    expect(quote.totalUzs).toBe(15_000);
  });

  it('compares the minimum with the subtotal before delivery', () => {
    expect(buildQuote([line(49_999, 1)], RULES).issues).toEqual(['below_min_order']);
    expect(buildQuote([line(50_000, 1)], RULES).issues).toEqual([]);
    expect(buildQuote([line(1, 1)], { ...RULES, minOrderUzs: 0 }).issues).toEqual([]);
  });

  it('excludes lines with issues and blocks the order', () => {
    const quote = buildQuote(
      [
        line(60_000, 1),
        line(10_000, 2, { isAvailable: false }),
        line(5_000, 3, { stockQuantity: 1 }),
      ],
      RULES,
    );
    expect(quote.subtotalUzs).toBe(60_000);
    expect(quote.issues).toEqual(['cart_has_issues']);
    expect(quote.lines.map((l) => l.issue)).toEqual([
      null,
      'product_inactive',
      'insufficient_stock',
    ]);
    const onlyInvalid = buildQuote([line(60_000, 1, { isAvailable: false })], RULES);
    expect(onlyInvalid.issues).toEqual(['cart_has_issues', 'below_min_order']);
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
