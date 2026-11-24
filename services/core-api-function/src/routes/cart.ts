/**
 * Signed-in user's cart (port of services/api/app/api/routes/cart.py). Reads need a session;
 * writes also need the CSRF token. Every response under `/cart` (errors included) is
 * `Cache-Control: no-store` (src/app.ts).
 *
 * Dependency order (so the same error wins as in FastAPI): JSON decoding, the per-IP limit
 * (router-level, before the session lookup), the per-user limit, the (CSRF-protected) user, then
 * path/body validation.
 */
import {
  CartError,
  CartItemNotFoundError,
  CartLimitReachedError,
  InsufficientStockError,
  ProductInactiveError,
  ProductNotFoundError,
  QuantityLimitExceededError,
} from '../domain/cart.ts';
import { ApiError } from '../errors.ts';
import { RULES, csrfProtectedUser, currentUser, rateLimit } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import { addItem, getCart, removeItem, setItemQuantity } from '../repositories/cart.ts';
import { Validation, uuid } from '../schemas/storefront/fields.ts';
import { readBody, readJsonBody, readPath } from '../schemas/storefront/http.ts';
import { addCartItemRequest, setCartItemQuantityRequest } from '../schemas/storefront/requests.ts';
import { cartBody } from '../schemas/storefront/responses.ts';
import type { Router } from './index.ts';

/** Map a cart rule violation to its public error. */
export function cartApiError(error: CartError): ApiError {
  if (error instanceof InsufficientStockError) {
    return new ApiError(409, 'insufficient_stock', 'Not enough stock', {
      extra: { available_quantity: error.availableQuantity },
    });
  }
  if (error instanceof QuantityLimitExceededError) {
    return new ApiError(422, 'validation_error', 'Request validation failed', {
      extra: {
        details: [{ loc: ['body', 'quantity'], msg: 'Quantity per item cannot exceed 99' }],
      },
    });
  }
  if (error instanceof ProductNotFoundError) {
    return new ApiError(404, 'product_not_found', 'Product not found');
  }
  if (error instanceof CartItemNotFoundError) {
    return new ApiError(404, 'cart_item_not_found', 'Cart item not found');
  }
  if (error instanceof ProductInactiveError) {
    return new ApiError(409, 'product_inactive', 'Product is not available');
  }
  if (error instanceof CartLimitReachedError) {
    return new ApiError(409, 'cart_limit_reached', 'Cart has too many items');
  }
  return new ApiError(500, 'internal_error', 'Internal server error');
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CartError) throw cartApiError(error);
    throw error;
  }
}

const productIdParam = uuid();

async function readCart(c: Ctx): Promise<Response> {
  await rateLimit(c, RULES.CART_IP, 'ip');
  await rateLimit(c, RULES.CART_READ, 'user');
  const user = await currentUser(c);
  return c.json(cartBody(await getCart(deps(c).db.pool, user.id)));
}

/** Add `quantity` to the line for `product_id` (creating it if needed). */
async function addCartItem(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.CART_IP, 'ip');
  await rateLimit(c, RULES.CART_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const payload = readBody(validation, body, addCartItemRequest);
  validation.check();
  const record = await mapped(() =>
    addItem(deps(c).db, user.id, payload.product_id, payload.quantity),
  );
  return c.json(cartBody(record));
}

/** Set the quantity of an existing line. */
async function setCartItemQuantity(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.CART_IP, 'ip');
  await rateLimit(c, RULES.CART_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const productId = readPath(validation, c, 'product_id', productIdParam);
  const payload = readBody(validation, body, setCartItemQuantityRequest);
  validation.check();
  const record = await mapped(() =>
    setItemQuantity(deps(c).db, user.id, productId, payload.quantity),
  );
  return c.json(cartBody(record));
}

/** Remove a line. Idempotent: removing a missing line still returns the cart. */
async function removeCartItem(c: Ctx): Promise<Response> {
  await rateLimit(c, RULES.CART_IP, 'ip');
  await rateLimit(c, RULES.CART_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const productId = readPath(validation, c, 'product_id', productIdParam);
  validation.check();
  return c.json(cartBody(await removeItem(deps(c).db, user.id, productId)));
}

export function register(router: Router): void {
  router.get('/cart', readCart);
  router.post('/cart/items', addCartItem);
  router.put('/cart/items/{product_id}', setCartItemQuantity);
  router.delete('/cart/items/{product_id}', removeCartItem);
}
