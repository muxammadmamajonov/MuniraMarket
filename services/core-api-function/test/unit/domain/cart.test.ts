import { describe, expect, it } from 'vitest';
import {
  CartLimitReachedError,
  InsufficientStockError,
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  QuantityLimitExceededError,
  checkCanAddLine,
  checkLineQuantity,
  evaluateCart,
  isInStock,
  lineIssue,
  type LineFacts,
} from '../../../src/domain/cart.ts';

const facts = (overrides: Partial<LineFacts> = {}): LineFacts => ({
  priceUzs: 10_000,
  quantity: 1,
  isAvailable: true,
  stockQuantity: null,
  ...overrides,
});

describe('cart rules (port of test_cart_domain.py)', () => {
  it('treats untracked stock as in stock', () => {
    expect([isInStock(null), isInStock(1), isInStock(0)]).toEqual([true, true, false]);
  });

  it('allows exact stock and refuses one more with the available quantity', () => {
    expect(() => checkLineQuantity(5, 5)).not.toThrow();
    const error = (() => {
      try {
        checkLineQuantity(6, 5);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).availableQuantity).toBe(5);
  });

  it('zero stock rejects any quantity', () => {
    expect(() => checkLineQuantity(1, 0)).toThrow(InsufficientStockError);
  });

  it('caps a line at 99 and lets the stock error win', () => {
    expect(() => checkLineQuantity(MAX_LINE_QUANTITY, null)).not.toThrow();
    expect(() => checkLineQuantity(MAX_LINE_QUANTITY + 1, null)).toThrow(
      QuantityLimitExceededError,
    );
    expect(() => checkLineQuantity(150, 120)).toThrow(InsufficientStockError);
  });

  it('caps the cart at 50 lines', () => {
    expect(() => checkCanAddLine(MAX_CART_LINES - 1)).not.toThrow();
    expect(() => checkCanAddLine(MAX_CART_LINES)).toThrow(CartLimitReachedError);
  });

  it('reports line issues, inactive first', () => {
    expect(lineIssue(false, 0, 5)).toBe('product_inactive');
    expect(lineIssue(true, 2, 3)).toBe('insufficient_stock');
    expect(lineIssue(true, null, 99)).toBeNull();
  });

  it('totals valid lines only', () => {
    expect(evaluateCart([]).totals).toEqual({
      itemCount: 0,
      subtotalUzs: 0,
      totalUzs: 0,
      hasIssues: false,
    });
    const { lines, totals } = evaluateCart([
      facts({ priceUzs: 12_000, quantity: 2 }),
      facts({ priceUzs: 5_000, quantity: 3, isAvailable: false }),
      facts({ priceUzs: 1_000, quantity: 4, stockQuantity: 3 }),
    ]);
    expect(lines.map((line) => [line.issue, line.lineTotalUzs])).toEqual([
      [null, 24_000],
      ['product_inactive', 15_000],
      ['insufficient_stock', 4_000],
    ]);
    expect(totals).toEqual({
      itemCount: 2,
      subtotalUzs: 24_000,
      totalUzs: 24_000,
      hasIssues: true,
    });
  });

  it('keeps money integer for large amounts', () => {
    const { totals } = evaluateCart([facts({ priceUzs: 9_999_999_999, quantity: 99 })]);
    expect(totals.subtotalUzs).toBe(989_999_999_901);
    expect(Number.isSafeInteger(totals.subtotalUzs)).toBe(true);
  });
});
