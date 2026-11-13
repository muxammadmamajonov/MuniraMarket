/**
 * Operator/admin back office: list orders, read one, change its status, lower a line (port of
 * services/api/app/api/routes/admin_orders.py).
 *
 * Only `operator` and `admin` users get past `requireStaff` (role re-read on every request, Login
 * Widget sessions only). Every response is `Cache-Control: no-store` (src/app.ts). Recipient
 * details are visible here because delivery needs them; they are never logged and never written
 * to the audit log.
 *
 * Dependency order: `backOfficeRouterDeps` (ADMIN_IP limit, admin-origin session), the per-user
 * ADMIN_READ/ADMIN_WRITE limit, the staff (writer) check, then query/path/body validation.
 */
import { ORDER_STATUSES } from '../domain/orderStatus.ts';
import { OrderNotFoundError } from '../domain/checkout.ts';
import {
  RULES,
  backOfficeRouterDeps,
  rateLimit,
  requireStaff,
  requireStaffWriter,
} from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import { adjustItem, changeStatus, getOrder, listAll } from '../repositories/orders.ts';
import { Validation, int, nullable, oneOf, uuid } from '../schemas/storefront/fields.ts';
import { readBody, readJsonBody, readPath, readQuery } from '../schemas/storefront/http.ts';
import {
  ORDERS_MAX_PAGE,
  ORDERS_MAX_PAGE_SIZE,
  orderItemAdjustRequest,
  orderStatusUpdateRequest,
  withDefault,
} from '../schemas/storefront/requests.ts';
import { adminOrderDetail, orderPage } from '../schemas/storefront/responses.ts';
import type { Router } from './index.ts';
import { checkoutApiError, mapCheckoutErrors, orderIdParam } from './orders.ts';

const adminOrderQuery = {
  status: nullable(oneOf(ORDER_STATUSES)),
  page: withDefault(int({ ge: 1, le: ORDERS_MAX_PAGE }), 1),
  page_size: withDefault(int({ ge: 1, le: ORDERS_MAX_PAGE_SIZE }), 20),
};

/** All orders (optionally one status), newest first. */
async function list(c: Ctx): Promise<Response> {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  await requireStaff(c);
  const validation = new Validation();
  const query = readQuery(validation, c, adminOrderQuery);
  validation.check();
  const record = await listAll(deps(c).db.pool, query.status, query.page, query.page_size);
  return c.json(orderPage(record, query.page, query.page_size));
}

async function get(c: Ctx): Promise<Response> {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  await requireStaff(c);
  const validation = new Validation();
  const orderId = readPath(validation, c, 'order_id', orderIdParam);
  validation.check();
  const record = await getOrder(deps(c).db.pool, orderId);
  if (record === null) throw checkoutApiError(new OrderNotFoundError());
  return c.json(adminOrderDetail(record));
}

/**
 * Move an order one step forward, or cancel it (`reason` required; stock is returned). Send
 * `expected_status` (the status you saw) to get `409 order_status_conflict` instead of
 * overwriting a colleague's change.
 */
async function updateStatus(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_WRITE, 'user');
  const staff = await requireStaffWriter(c);
  const validation = new Validation();
  const orderId = readPath(validation, c, 'order_id', orderIdParam);
  const payload = readBody(validation, body, orderStatusUpdateRequest);
  validation.check();
  const { db, logger } = deps(c);
  const record = await mapCheckoutErrors(() =>
    changeStatus(db, orderId, payload.status, {
      actor: { userId: staff.id, role: staff.role },
      reason: payload.reason,
      expectedStatus: payload.expected_status,
    }),
  );
  logger.info('Staff order status change succeeded');
  return c.json(adminOrderDetail(record));
}

/**
 * Lower one order line because the goods are not there (ADR 0018). Only while the order is NEW,
 * CONFIRMED or PICKING (else `409 order_not_adjustable`), and only down (more than the line's
 * quantity is `409 invalid_quantity`). The units the line no longer takes go back to stock, or,
 * with `mark_out_of_stock`, the product's stock becomes 0. A line already at `quantity` is
 * returned unchanged, so a retry is harmless. When every line reaches 0 the order is cancelled.
 */
async function adjustLine(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_WRITE, 'user');
  const staff = await requireStaffWriter(c);
  const validation = new Validation();
  const orderId = readPath(validation, c, 'order_id', orderIdParam);
  const productId = readPath(validation, c, 'product_id', uuid());
  const payload = readBody(validation, body, orderItemAdjustRequest);
  validation.check();
  const { db, logger } = deps(c);
  const record = await mapCheckoutErrors(() =>
    adjustItem(db, orderId, productId, {
      quantity: payload.quantity,
      reason: payload.reason,
      markOutOfStock: payload.mark_out_of_stock,
      actor: { userId: staff.id, role: staff.role },
    }),
  );
  logger.info('Staff order line adjustment succeeded');
  return c.json(adminOrderDetail(record));
}

export function register(router: Router): void {
  router.get('/admin/orders', list);
  router.get('/admin/orders/{order_id}', get);
  router.patch('/admin/orders/{order_id}/status', updateStatus);
  router.patch('/admin/orders/{order_id}/items/{product_id}', adjustLine);
}
