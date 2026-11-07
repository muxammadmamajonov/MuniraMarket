/**
 * Checkout rules as pure functions: the quote (subtotal, delivery fee, total) and order errors
 * (port of services/api/app/domain/checkout.py).
 *
 * The quote and order creation evaluate the cart with exactly the same function, so what the
 * customer is shown is what the order is created with (or the order is refused). Money is integer
 * UZS; clients never send prices, only the total they were shown (`expected_total_uzs`) so a price
 * change between quote and order is detected instead of silently charged.
 */
import { evaluateCart, type CartTotals, type EvaluatedLine, type LineFacts } from './cart.ts';
import { deliveryFeeFor, freeDeliveryRemaining, type ZoneRules } from './delivery.ts';

export type QuoteIssue = 'cart_empty' | 'cart_has_issues' | 'below_min_order';

/**
 * Unconfirmed (`NEW`) orders one customer may have at once. Cash/card on delivery means an order
 * costs nothing to place, so this bounds how much tracked stock one account can hold.
 */
export const MAX_OPEN_ORDERS = 5;

export interface QuoteTotals {
  lines: EvaluatedLine[];
  cart: CartTotals;
  subtotalUzs: number;
  deliveryFeeUzs: number;
  totalUzs: number;
  freeDeliveryRemainingUzs: number | null;
  issues: QuoteIssue[];
  canPlaceOrder: boolean;
}

/**
 * Evaluate the cart against a zone. Lines with an issue are excluded from the subtotal (as in the
 * cart) and block the order. The minimum order is compared with the subtotal of valid lines,
 * before delivery.
 */
export function buildQuote(lines: readonly LineFacts[], rules: ZoneRules): QuoteTotals {
  const { lines: evaluated, totals: cart } = evaluateCart(lines);
  const subtotal = cart.subtotalUzs;
  const fee = deliveryFeeFor(rules, subtotal);
  const issues: QuoteIssue[] = [];
  if (lines.length === 0) issues.push('cart_empty');
  if (cart.hasIssues) issues.push('cart_has_issues');
  if (lines.length > 0 && subtotal < rules.minOrderUzs) issues.push('below_min_order');
  return {
    lines: evaluated,
    cart,
    subtotalUzs: subtotal,
    deliveryFeeUzs: fee,
    totalUzs: subtotal + fee,
    freeDeliveryRemainingUzs: freeDeliveryRemaining(rules, subtotal),
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

export class DistrictNotServedError extends CheckoutError {}
export class CartEmptyError extends CheckoutError {}
export class BelowMinimumOrderError extends CheckoutError {}
/** The customer already has `MAX_OPEN_ORDERS` orders waiting for confirmation. */
export class TooManyOpenOrdersError extends CheckoutError {}
/** The key was already used by this user for a different order request. */
export class IdempotencyKeyConflictError extends CheckoutError {}
/** Unknown order, or not the caller's (both look the same: no IDOR oracle). */
export class OrderNotFoundError extends CheckoutError {}
/** The zone has bookable delivery slots, so the order must name one. */
export class SlotRequiredError extends CheckoutError {}
/** Unknown slot, inactive, of another zone, or its cutoff has passed. */
export class SlotUnavailableError extends CheckoutError {}
/** Every place in the slot is taken. */
export class SlotFullError extends CheckoutError {}

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
