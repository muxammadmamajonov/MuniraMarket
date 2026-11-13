/**
 * Checkout quote, order creation and the customer's own orders (port of `checkout_router` and
 * `router` in services/api/app/api/routes/orders.py). Session required everywhere; writes (every
 * POST here) also need the CSRF token.
 *
 * Every route is first limited per IP (`orders_ip`, before the session lookup), then per user.
 * Every response (errors included) is `Cache-Control: no-store` (src/app.ts). Orders are looked
 * up by id *and* the signed-in user, so another customer's order is indistinguishable from a
 * missing one (404). Request bodies (addresses, phone numbers) are never logged.
 */
import {
  CartEmptyError,
  CheckoutError,
  IdempotencyKeyConflictError,
  InvalidStatusTransitionError,
  OrderInsufficientStockError,
  OrderNotCancellableError,
  OrderNotFoundError,
  OrderProductUnavailableError,
  OrderStatusConflictError,
  PriceChangedError,
  TooManyOpenOrdersError,
} from '../domain/checkout.ts';
import { ApiError } from '../errors.ts';
import { RULES, csrfProtectedUser, currentUser, rateLimit } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import {
  cancelForUser,
  createOrder,
  getForUser,
  listForUser,
  quote as quoteOrder,
} from '../repositories/orders.ts';
import { Validation, uuid } from '../schemas/storefront/fields.ts';
import { readBody, readJsonBody, readPath, readQuery } from '../schemas/storefront/http.ts';
import {
  cancelOrderRequest,
  createOrderRequest,
  idempotencyKeyHeader,
  orderPageQuery,
  requestHash,
} from '../schemas/storefront/requests.ts';
import { checkoutQuote, orderDetail, orderPage } from '../schemas/storefront/responses.ts';
import type { Router } from './index.ts';

export const REPLAY_HEADER = 'Idempotent-Replayed';

/** Map a checkout/order rule violation to its public error. */
export function checkoutApiError(error: CheckoutError): ApiError {
  if (error instanceof OrderInsufficientStockError) {
    return new ApiError(409, 'insufficient_stock', 'Not enough stock', {
      extra: { available_quantity: error.availableQuantity, product_id: error.productId },
    });
  }
  if (error instanceof OrderProductUnavailableError) {
    return new ApiError(409, 'product_inactive', 'Product is not available', {
      extra: { product_id: error.productId },
    });
  }
  if (error instanceof PriceChangedError) {
    return new ApiError(409, 'price_changed', 'Order total has changed', {
      extra: { total_uzs: error.totalUzs },
    });
  }
  if (error instanceof OrderNotCancellableError) {
    return new ApiError(409, 'order_not_cancellable', 'Order can no longer be cancelled', {
      extra: { current_status: error.currentStatus },
    });
  }
  if (error instanceof OrderStatusConflictError) {
    return new ApiError(409, 'order_status_conflict', 'Order status has changed', {
      extra: { current_status: error.currentStatus },
    });
  }
  if (error instanceof InvalidStatusTransitionError) {
    return new ApiError(409, 'invalid_status_transition', 'Status change not allowed', {
      extra: { current_status: error.currentStatus },
    });
  }
  if (error instanceof CartEmptyError) return new ApiError(409, 'cart_empty', 'Cart is empty');
  if (error instanceof IdempotencyKeyConflictError) {
    return new ApiError(
      409,
      'idempotency_key_conflict',
      'Idempotency key was used for a different order',
    );
  }
  if (error instanceof OrderNotFoundError) {
    return new ApiError(404, 'order_not_found', 'Order not found');
  }
  if (error instanceof TooManyOpenOrdersError) {
    return new ApiError(409, 'too_many_open_orders', 'Too many orders waiting for confirmation');
  }
  return new ApiError(500, 'internal_error', 'Internal server error');
}

export async function mapCheckoutErrors<T>(
  work: () => Promise<T>,
  onRefused?: (e: CheckoutError) => void,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CheckoutError) {
      onRefused?.(error);
      throw checkoutApiError(error);
    }
    throw error;
  }
}

export const orderIdParam = uuid();

/** Router-level dependency of `/checkout` and `/orders`: the per-IP limit. */
async function ordersIpLimit(c: Ctx): Promise<void> {
  await rateLimit(c, RULES.ORDERS_IP, 'ip');
}

/**
 * Re-check the cart (status, current price, stock); takes no body. Delivery is on demand by a
 * Yandex Go courier the customer pays, so the total is the subtotal. Never fails because of the
 * cart's contents: problems are reported in `issues` and `can_place_order`.
 */
async function quote(c: Ctx): Promise<Response> {
  await ordersIpLimit(c);
  await rateLimit(c, RULES.CHECKOUT_QUOTE, 'user');
  const user = await csrfProtectedUser(c);
  const record = await quoteOrder(deps(c).db.pool, user.id);
  return c.json(checkoutQuote(record));
}

/**
 * Place an order from the whole cart. The same `Idempotency-Key` with the same body returns the
 * original order (`200` and `Idempotent-Replayed: true`); with a different body it is
 * `409 idempotency_key_conflict`.
 */
async function create(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await ordersIpLimit(c);
  await rateLimit(c, RULES.ORDER_CREATE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const key = validation.run(idempotencyKeyHeader, c.req.header('idempotency-key'), [
    'header',
    'Idempotency-Key',
  ]) as string;
  const payload = readBody(validation, body, createOrderRequest);
  validation.check();

  const { db, clock, logger, settings } = deps(c);
  if (settings.checkoutRequireVerifiedPhone && !user.phone_verified) {
    throw new ApiError(409, 'phone_verification_required', 'Verify your phone number first');
  }
  const created = await mapCheckoutErrors(
    () =>
      createOrder(
        db,
        user.id,
        {
          address: payload.address,
          recipientName: payload.recipient_name,
          recipientPhone: payload.recipient_phone,
          paymentMethod: payload.payment_method,
          comment: payload.comment,
          expectedTotalUzs: payload.expected_total_uzs,
        },
        { idempotencyKey: key, requestHash: requestHash(payload), now: clock() },
      ),
    (error) => logger.info(`Order refused: ${error.name}`),
  );
  if (created.replayed) {
    return c.json(orderDetail(created.order), 200, { [REPLAY_HEADER]: 'true' });
  }
  logger.info(`Order created: ${created.order.id}`);
  return c.json(orderDetail(created.order), 201);
}

/**
 * The signed-in customer's orders, newest first, optionally one tab of the history
 * (`status_group`); `total` and `total_pages` count that group only.
 */
async function list(c: Ctx): Promise<Response> {
  await ordersIpLimit(c);
  await rateLimit(c, RULES.ORDER_READ, 'user');
  const user = await currentUser(c);
  const validation = new Validation();
  const query = readQuery(validation, c, orderPageQuery);
  validation.check();
  const record = await listForUser(
    deps(c).db.pool,
    user.id,
    query.page,
    query.page_size,
    query.status_group,
  );
  return c.json(orderPage(record, query.page, query.page_size));
}

async function get(c: Ctx): Promise<Response> {
  await ordersIpLimit(c);
  await rateLimit(c, RULES.ORDER_READ, 'user');
  const user = await currentUser(c);
  const validation = new Validation();
  const orderId = readPath(validation, c, 'order_id', orderIdParam);
  validation.check();
  const record = await getForUser(deps(c).db.pool, user.id, orderId);
  if (record === null) throw checkoutApiError(new OrderNotFoundError());
  return c.json(orderDetail(record));
}

/** Cancel while the order is `NEW` or `CONFIRMED`; tracked stock is returned. */
async function cancel(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await ordersIpLimit(c);
  await rateLimit(c, RULES.ORDER_CANCEL, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const orderId = readPath(validation, c, 'order_id', orderIdParam);
  const payload = readBody(validation, body, cancelOrderRequest);
  validation.check();
  const { db, logger } = deps(c);
  const record = await mapCheckoutErrors(() => cancelForUser(db, user.id, orderId, payload.reason));
  logger.info('Customer order cancellation succeeded');
  return c.json(orderDetail(record));
}

export function register(router: Router): void {
  router.post('/checkout/quote', quote);
  router.post('/orders', create);
  router.get('/orders', list);
  router.get('/orders/{order_id}', get);
  router.post('/orders/{order_id}/cancel', cancel);
}
