/**
 * Checkout rules as pure functions: the quote (subtotal and total) and order errors (port of
 * services/api/app/domain/checkout.py).
 *
 * The store charges nothing for delivery: a Yandex Go courier carries each order on demand and the
 * customer pays the courier, so the total is the subtotal of the valid lines. The quote and order
 * creation evaluate the cart with exactly the same function, so what the customer is shown is what
 * the order is created with (or the order is refused). Money is integer UZS; clients never send
 * prices, only the total they were shown (`expected_total_uzs`) so a price change between quote
 * and order is detected instead of silently charged.
 */
import { evaluateCart, type CartTotals, type EvaluatedLine, type LineFacts } from './cart.ts';

export type QuoteIssue = 'cart_empty' | 'cart_has_issues';

/**
 * Unconfirmed (`NEW`) orders one customer may have at once. Cash/card on delivery means an order
 * costs nothing to place, so this bounds how much tracked stock one account can hold.
 */
export const MAX_OPEN_ORDERS = 5;

export interface QuoteTotals {
  lines: EvaluatedLine[];
  cart: CartTotals;
  subtotalUzs: number;
  /** Always equal to `subtotalUzs`. */
  totalUzs: number;
  issues: QuoteIssue[];
  canPlaceOrder: boolean;
}

/**
 * Evaluate the cart. Lines with an issue are excluded from the subtotal (as in the cart) and block
 * the order.
 */
export function buildQuote(lines: readonly LineFacts[]): QuoteTotals {
  const { lines: evaluated, totals: cart } = evaluateCart(lines);
  const issues: QuoteIssue[] = [];
  if (lines.length === 0) issues.push('cart_empty');
  if (cart.hasIssues) issues.push('cart_has_issues');
  return {
    lines: evaluated,
    cart,
    subtotalUzs: cart.subtotalUzs,
    totalUzs: cart.subtotalUzs,
    issues,
    canPlaceOrder: issues.length === 0,
  };
}

// --- phone ---------------------------------------------------------------------------------------

// ASCII digits only: `\d` with the `u` flag is ASCII in JS, but be explicit like the reference.
const UZ_PHONE_RE = /^\+998[0-9]{9}$/;
// Python's `\s` (str patterns) plus `-`, `(` and `)`.
const PHONE_SEPARATORS = new RegExp(
  // eslint-disable-next-line no-control-regex -- Python's \s includes \x1c-\x1f
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\-()]',
  'g',
);
export const PHONE_MESSAGE = 'phone must be an Uzbekistan number: +998 followed by 9 digits';

/** `+998 00 123-45-67` -> `+998001234567`. Throws `RangeError` for anything else. */
export function normalizeUzPhone(raw: string): string {
  const compact = raw.replace(PHONE_SEPARATORS, '');
  if (!UZ_PHONE_RE.test(compact)) throw new RangeError(PHONE_MESSAGE);
  return compact;
}

// --- errors raised by the order repository -------------------------------------------------------

/** Base class for checkout/order rule violations. */
export class CheckoutError extends Error {
  constructor(message = 'checkout rule violated') {
    super(message);
    this.name = new.target.name;
  }
}

export class CartEmptyError extends CheckoutError {}
/** The customer already has `MAX_OPEN_ORDERS` orders waiting for confirmation. */
export class TooManyOpenOrdersError extends CheckoutError {}
/** The key was already used by this user for a different order request. */
export class IdempotencyKeyConflictError extends CheckoutError {}
/** Unknown order, or not the caller's (both look the same: no IDOR oracle). */
export class OrderNotFoundError extends CheckoutError {}

export class OrderProductUnavailableError extends CheckoutError {
  readonly productId: string;
  constructor(productId: string) {
    super('product is not available');
    this.productId = productId;
  }
}

export class OrderInsufficientStockError extends CheckoutError {
  readonly productId: string;
  readonly availableQuantity: number;
  constructor(productId: string, availableQuantity: number) {
    super(`only ${availableQuantity} in stock`);
    this.productId = productId;
    this.availableQuantity = availableQuantity;
  }
}

export class PriceChangedError extends CheckoutError {
  readonly totalUzs: number;
  constructor(totalUzs: number) {
    super('order total changed since the quote');
    this.totalUzs = totalUzs;
  }
}

export class OrderNotCancellableError extends CheckoutError {
  readonly currentStatus: string;
  constructor(currentStatus: string) {
    super(`order cannot be cancelled in status ${currentStatus}`);
    this.currentStatus = currentStatus;
  }
}

/** Optimistic concurrency: the order is no longer in the status the operator saw. */
export class OrderStatusConflictError extends CheckoutError {
  readonly currentStatus: string;
  constructor(currentStatus: string) {
    super(`order is now ${currentStatus}`);
    this.currentStatus = currentStatus;
  }
}

export class InvalidStatusTransitionError extends CheckoutError {
  readonly currentStatus: string;
  constructor(currentStatus: string) {
    super(`transition not allowed from ${currentStatus}`);
    this.currentStatus = currentStatus;
  }
}
