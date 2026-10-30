import { ApiRequestError } from '@/lib/api/errors';
import { serverFieldErrors, type FormErrors } from './form';

/**
 * What went wrong when placing an order (or pricing the cart), reduced to what the UI has to
 * decide: which message to show and whether the same request may simply be sent again.
 */
export type CheckoutFailure =
  /** The total the customer confirmed is no longer what the server would charge. */
  | { kind: 'price_changed'; newTotal: number }
  | { kind: 'insufficient_stock'; available: number | null }
  | { kind: 'product_inactive' }
  | { kind: 'cart_empty' }
  | { kind: 'below_min_order' }
  | { kind: 'district_not_served' }
  /** The customer already has the maximum number of unconfirmed (NEW) orders. */
  | { kind: 'too_many_open_orders' }
  | { kind: 'validation'; fields: FormErrors; unmapped: number }
  /** Wait `seconds`, then the same request (and key) may be sent again. */
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'session' }
  | { kind: 'blocked' }
  /** No HTTP answer at all: the request may or may not have reached the server. */
  | { kind: 'network' }
  | { kind: 'server' }
  /** The key was already used for a different body; a new key is needed. */
  | { kind: 'key_conflict' };

/** Used when `Retry-After` is missing. */
export const DEFAULT_RETRY_SECONDS = 10;
/** Cap so a bogus `Retry-After` cannot lock the button for hours. */
export const MAX_RETRY_SECONDS = 120;

export function classifyCheckoutError(error: unknown): CheckoutFailure {
  if (!(error instanceof ApiRequestError)) return { kind: 'server' };
  switch (error.code) {
    case 'price_changed':
      return error.totalUzs === null
        ? { kind: 'server' }
        : { kind: 'price_changed', newTotal: error.totalUzs };
    case 'insufficient_stock':
      return { kind: 'insufficient_stock', available: error.availableQuantity };
    case 'product_inactive':
    case 'product_not_found':
      return { kind: 'product_inactive' };
    case 'cart_empty':
      return { kind: 'cart_empty' };
    case 'below_min_order':
      return { kind: 'below_min_order' };
    case 'district_not_served':
      return { kind: 'district_not_served' };
    case 'too_many_open_orders':
      return { kind: 'too_many_open_orders' };
    case 'validation_error': {
      const { fields, unmapped } = serverFieldErrors(error.details);
      return { kind: 'validation', fields, unmapped };
    }
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        seconds: Math.min(Math.ceil(error.retryAfter ?? DEFAULT_RETRY_SECONDS), MAX_RETRY_SECONDS),
      };
    case 'session_required':
    case 'unauthorized':
    case 'csrf_failed':
      return { kind: 'session' };
    case 'account_blocked':
      return { kind: 'blocked' };
    case 'idempotency_key_conflict':
      return { kind: 'key_conflict' };
    case 'network_error':
      return { kind: 'network' };
    default:
      return { kind: 'server' };
  }
}

/** True when sending the identical request again (same key) is the right way to retry. */
export function isRetrySafe(failure: CheckoutFailure): boolean {
  return failure.kind === 'network' || failure.kind === 'server' || failure.kind === 'rate_limited';
}
