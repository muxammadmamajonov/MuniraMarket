import { ApiRequestError } from '@/lib/api/errors';
import type { Dictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';

/**
 * Customer-facing message for a failed "add to cart" call. Shared by the product page and the
 * product cards so both say the same thing. A lost session is retried through `retrySession` so
 * the sign-in prompt can take over.
 */
export function addToCartErrorMessage(
  error: unknown,
  dict: Dictionary,
  retrySession: () => void,
): string {
  if (!(error instanceof ApiRequestError)) return dict.product.errors.generic;
  switch (error.code) {
    case 'insufficient_stock':
      return formatMessage(dict.product.errors.insufficientStock, {
        available: error.availableQuantity ?? 0,
      });
    case 'product_inactive':
    case 'product_not_found':
      return dict.product.errors.productInactive;
    case 'cart_limit_reached':
      return dict.product.errors.cartLimit;
    case 'session_required':
      // The session expired underneath us; re-establish it so the sign-in prompt can take over.
      retrySession();
      return dict.product.errors.generic;
    default:
      return dict.product.errors.generic;
  }
}
