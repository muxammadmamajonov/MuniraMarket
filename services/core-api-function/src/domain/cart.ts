/**
 * Cart rules as pure, dependency-free functions: quantity limits, line issues and totals (port of
 * services/api/app/domain/cart.py).
 *
 * Money is integer UZS. The cart never reserves stock; checkout re-validates.
 */

export const MAX_LINE_QUANTITY = 99;
export const MAX_CART_LINES = 50;
/** A tracked product with this many sellable units or fewer (but some) is "low stock". */
export const LOW_STOCK_THRESHOLD = 3;

export type CartIssue = 'product_inactive' | 'insufficient_stock';

/** Base class for rule violations raised by the cart repository. */
export class CartError extends Error {
  constructor(message = 'cart rule violated') {
    super(message);
    this.name = new.target.name;
  }
}

export class ProductNotFoundError extends CartError {}
export class ProductInactiveError extends CartError {}
export class QuantityLimitExceededError extends CartError {}
export class CartLimitReachedError extends CartError {}
export class CartItemNotFoundError extends CartError {}

export class InsufficientStockError extends CartError {
  readonly availableQuantity: number;

  constructor(availableQuantity: number) {
    super(`only ${availableQuantity} in stock`);
    this.availableQuantity = availableQuantity;
  }
}

/**
 * What the online store may sell (ADR 0018): physical stock minus the units kept back for walk-in
 * shoppers, never below 0. `null` (stock not tracked) stays `null`. Every storefront availability
 * rule works on this number; the repositories select it as the summary's `stock_quantity`.
 */
export function sellableQuantity(stockQuantity: number | null, safetyStock: number): number | null {
  if (stockQuantity === null) return null;
  return Math.max(stockQuantity - Math.max(safetyStock, 0), 0);
}

/** `null` means stock is not tracked, which counts as always in stock. */
export function isInStock(stockQuantity: number | null): boolean {
  return stockQuantity === null || stockQuantity > 0;
}

/** Tracked, with at least one but at most `LOW_STOCK_THRESHOLD` sellable units. */
export function isLowStock(stockQuantity: number | null): boolean {
  return stockQuantity !== null && stockQuantity > 0 && stockQuantity <= LOW_STOCK_THRESHOLD;
}

/**
 * Validate the *resulting* quantity of one line for an orderable product. Stock is checked first
 * because it carries an actionable number (`available_quantity`).
 */
export function checkLineQuantity(quantity: number, stockQuantity: number | null): void {
  if (stockQuantity !== null && quantity > stockQuantity) {
    throw new InsufficientStockError(stockQuantity);
  }
  if (quantity > MAX_LINE_QUANTITY) throw new QuantityLimitExceededError();
}

/** A *new* line is refused once the cart already has the maximum number of lines. */
export function checkCanAddLine(existingLines: number): void {
  if (existingLines >= MAX_CART_LINES) throw new CartLimitReachedError();
}

/** What (if anything) is wrong with an existing cart line right now. */
export function lineIssue(
  isAvailable: boolean,
  stockQuantity: number | null,
  quantity: number,
): CartIssue | null {
  if (!isAvailable) return 'product_inactive';
  if (stockQuantity !== null && quantity > stockQuantity) return 'insufficient_stock';
  return null;
}

/** Facts needed to evaluate one line (`isAvailable`: product and its categories active). */
export interface LineFacts {
  priceUzs: number;
  quantity: number;
  isAvailable: boolean;
  stockQuantity: number | null;
}

export interface EvaluatedLine {
  issue: CartIssue | null;
  lineTotalUzs: number;
}

export interface CartTotals {
  itemCount: number;
  subtotalUzs: number;
  totalUzs: number;
  hasIssues: boolean;
}

/** `lineTotalUzs` is always price x quantity; lines with an issue are excluded later. */
export function evaluateLine(facts: LineFacts): EvaluatedLine {
  return {
    issue: lineIssue(facts.isAvailable, facts.stockQuantity, facts.quantity),
    lineTotalUzs: facts.priceUzs * facts.quantity,
  };
}

/**
 * Evaluate every line, then total only the valid ones. `totalUzs` equals the subtotal (the store
 * charges nothing for delivery: the customer pays the Yandex Go courier).
 */
export function evaluateCart(lines: readonly LineFacts[]): {
  lines: EvaluatedLine[];
  totals: CartTotals;
} {
  const evaluated = lines.map(evaluateLine);
  let itemCount = 0;
  let subtotal = 0;
  let valid = 0;
  lines.forEach((facts, index) => {
    const result = evaluated[index];
    if (result?.issue === null) {
      valid += 1;
      itemCount += facts.quantity;
      subtotal += result.lineTotalUzs;
    }
  });
  return {
    lines: evaluated,
    totals: {
      itemCount,
      subtotalUzs: subtotal,
      totalUzs: subtotal,
      hasIssues: valid !== lines.length,
    },
  };
}
