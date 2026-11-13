// @ts-check
/**
 * Drain adapter for the Core API order-notification outbox (ADR 0008).
 *
 * Flow: `claimNotifications` leases a batch; each message is validated, handed to a transport, and
 * its outcome is reported back. Delivery is AT LEAST ONCE: a message whose result is not reported
 * before the lease expires (60 s) is redelivered, and a crash between "sent" and "reported" sends
 * it twice. Nothing in this module runs on its own: the api-gateway Worker's Cloudflare Cron
 * Trigger calls `drainOrderNotifications` every minute (Telegram Serverless has no scheduler; see
 * services/telegram/README.md). Four event types are delivered: `order.status_changed` and
 * `order.adjusted` (to the customer), `order.staff_alert` and `order.staff_adjusted` (to the
 * connected staff group).
 *
 * Everything is injected (Core API client, transport, clock); there are no globals, and nothing
 * from a payload (names, order numbers, chat ids) is ever logged or put into an error code.
 */
import { isOrderStatus } from '../i18n.js';
import { isGeoPoint } from './yandexGo.js';

export const ORDER_STATUS_CHANGED = 'order.status_changed';
export const ORDER_STAFF_ALERT = 'order.staff_alert';
/** Order lines lowered at picking (ADR 0018): the customer's message and the staff group's. */
export const ORDER_ADJUSTED = 'order.adjusted';
export const ORDER_STAFF_ADJUSTED = 'order.staff_adjusted';
/** Lease length the Core API grants per claim. */
export const LEASE_MS = 60_000;
/** Stop delivering when less than this much of the lease is left, so reports still fit in. */
export const LEASE_SAFETY_MARGIN_MS = 10_000;
export const DEFAULT_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ORDER_NUMBER_CHARS = 32;
const MAX_TELEGRAM_ID = 2 ** 52;
/** Group and supergroup chat ids are negative; same bound as the Core API's staff-chat route. */
const MIN_GROUP_CHAT_ID = -(10 ** 15);
const ERROR_CODE_RE = /^[a-z0-9_.-]{1,64}$/;
const UNITS = Object.freeze(['piece', 'kg', 'g', 'l', 'ml']);
const PAYMENT_METHODS = Object.freeze(['cash_on_delivery', 'card_on_delivery']);
/** Same bound as the cart (50 lines). */
const MAX_LINES = 50;
const MAX_TEXT_CHARS = 1000;
const OUTCOMES = Object.freeze(['delivered', 'recipient_blocked', 'retry', 'failed']);

/**
 * The part of the Core API client the drain needs (`createCoreApiClient()` satisfies it).
 * @typedef {Pick<import('../types.js').CoreApiClient, 'claimNotifications' | 'reportNotification'>} OutboxCoreApi
 */

/**
 * @typedef {object} DrainSummary
 * @property {number} claimed messages leased from the Core API
 * @property {number} delivered reported `delivered`
 * @property {number} blocked reported `recipient_blocked`
 * @property {number} retried reported `retry`
 * @property {number} failed reported `failed` (includes unknown events and malformed payloads)
 * @property {number} skipped claimed but left alone (lease nearly over, or unusable id); the Core
 *   API redelivers them when the lease expires
 * @property {number} reportFailed outcomes that could not be reported (those messages will be
 *   redelivered, so a `delivered` one may be sent twice)
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isAmount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {value is string}
 */
function isText(value, maxChars = MAX_TEXT_CHARS) {
  return typeof value === 'string' && Array.from(value).length <= maxChars;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isOrderId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isGroupChatId(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value < 0 &&
    value >= MIN_GROUP_CHAT_ID
  );
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isPayloadOrderNumber(value) {
  return (
    typeof value === 'string' && value !== '' && Array.from(value).length <= MAX_ORDER_NUMBER_CHARS
  );
}

/**
 * `null` when absent or not a non-empty string; otherwise the string (renderers clean and cap it).
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalText(value) {
  return isText(value) && value.trim() !== '' ? value : undefined;
}

/**
 * Validates the `details` of a NEW order's staff alert. Any defect drops all of them (the alert
 * is then sent in its short form: the order number and total are what staff must not miss).
 * @param {unknown} details
 * @returns {import('./staffAlert.js').StaffAlertDetails | undefined}
 */
export function parseStaffAlertDetails(details) {
  if (!isPlainObject(details)) return undefined;
  const {
    items,
    subtotal_uzs: subtotalUzs,
    payment_method: paymentMethod,
    recipient_phone: recipientPhone,
    address,
    comment,
    created_at: createdAt,
  } = details;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) return undefined;
  /** @type {import('./staffAlert.js').StaffAlertItem[]} */
  const parsedItems = [];
  for (const item of items) {
    if (!isPlainObject(item)) return undefined;
    const { name_uz: nameUz, quantity, unit, line_total_uzs: lineTotalUzs } = item;
    if (!isText(nameUz) || !isAmount(quantity) || !isAmount(lineTotalUzs)) return undefined;
    if (typeof unit !== 'string' || !UNITS.includes(unit)) return undefined;
    parsedItems.push({
      nameUz,
      quantity,
      unit: /** @type {import('../types.js').Unit} */ (unit),
      lineTotalUzs,
    });
  }
  if (!isAmount(subtotalUzs)) return undefined;
  if (typeof paymentMethod !== 'string' || !PAYMENT_METHODS.includes(paymentMethod)) {
    return undefined;
  }
  if (!isText(recipientPhone, 32) || !isPlainObject(address)) return undefined;
  const { street, house, apartment, entrance, floor, landmark } = address;
  if (!isText(street) || !isText(house)) return undefined;
  for (const part of [apartment, entrance, floor, landmark]) {
    if (part !== null && part !== undefined && !isText(part)) return undefined;
  }
  if (comment !== null && comment !== undefined && !isText(comment)) return undefined;
  if (createdAt !== null && createdAt !== undefined && !isText(createdAt, 64)) return undefined;
  /** @param {unknown} value */
  const orNull = (value) => (typeof value === 'string' ? value : null);
  return {
    items: parsedItems,
    subtotalUzs,
    paymentMethod: /** @type {'cash_on_delivery' | 'card_on_delivery'} */ (paymentMethod),
    recipientPhone,
    address: {
      street,
      house,
      apartment: orNull(apartment),
      entrance: orNull(entrance),
      floor: orNull(floor),
      landmark: orNull(landmark),
    },
    comment: orNull(comment),
    createdAt: orNull(createdAt),
  };
}

/**
 * Validates the `changes` of an adjustment payload (1..50 lines, each lowered, never raised).
 * @param {unknown} changes
 * @param {boolean} staff whether each change must carry `marked_out_of_stock`
 * @returns {Array<{ nameUz: string, nameRu: string, unit: import('../types.js').Unit, fromQuantity: number, toQuantity: number, markedOutOfStock: boolean }> | null}
 */
function parseChanges(changes, staff) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_LINES) return null;
  const parsed = [];
  for (const change of changes) {
    if (!isPlainObject(change)) return null;
    const {
      name_uz: nameUz,
      name_ru: nameRu,
      unit,
      from_quantity: fromQuantity,
      to_quantity: toQuantity,
      marked_out_of_stock: markedOutOfStock,
    } = change;
    if (!isText(nameUz) || !isText(nameRu)) return null;
    if (typeof unit !== 'string' || !UNITS.includes(unit)) return null;
    if (!isAmount(fromQuantity) || !isAmount(toQuantity) || toQuantity >= fromQuantity) {
      return null;
    }
    if (staff && typeof markedOutOfStock !== 'boolean') return null;
    parsed.push({
      nameUz,
      nameRu,
      unit: /** @type {import('../types.js').Unit} */ (unit),
      fromQuantity,
      toQuantity,
      markedOutOfStock: markedOutOfStock === true,
    });
  }
  return parsed;
}

/**
 * Strictly validates an `order.adjusted` payload (the customer's "your order changed" message).
 * @param {unknown} payload
 * @returns {import('./transport.js').OrderAdjustedNotification | null} null when malformed
 */
export function parseOrderAdjustedPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const {
    order_id: orderId,
    order_number: orderNumber,
    locale,
    total_uzs: totalUzs,
    chat_id: chatId,
    changes,
  } = payload;
  if (!isOrderId(orderId) || !isPayloadOrderNumber(orderNumber)) return null;
  if (locale !== 'uz' && locale !== 'ru') return null;
  if (!isAmount(totalUzs)) return null;
  if (
    typeof chatId !== 'number' ||
    !Number.isSafeInteger(chatId) ||
    chatId <= 0 ||
    chatId > MAX_TELEGRAM_ID
  ) {
    return null;
  }
  const parsed = parseChanges(changes, false);
  if (parsed === null) return null;
  return {
    kind: 'order_adjusted',
    chatId,
    orderNumber,
    locale,
    totalUzs,
    changes: parsed.map(({ nameUz, nameRu, unit, fromQuantity, toQuantity }) => ({
      nameUz,
      nameRu,
      unit,
      fromQuantity,
      toQuantity,
    })),
  };
}

/**
 * Strictly validates an `order.staff_adjusted` payload (the staff group's short alert).
 * @param {unknown} payload
 * @returns {import('./transport.js').StaffAdjustedNotification | null} null when malformed
 */
export function parseStaffAdjustedPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const {
    order_id: orderId,
    order_number: orderNumber,
    total_uzs: totalUzs,
    chat_id: chatId,
    recipient_name: recipientName,
    changes,
    reason,
  } = payload;
  if (!isOrderId(orderId) || !isPayloadOrderNumber(orderNumber)) return null;
  if (!isAmount(totalUzs) || !isGroupChatId(chatId) || !isText(reason)) return null;
  const parsed = parseChanges(changes, true);
  if (parsed === null) return null;
  /** @type {import('./transport.js').StaffAdjustedNotification} */
  const alert = {
    kind: 'staff_adjusted',
    chatId,
    orderId,
    orderNumber,
    totalUzs,
    changes: parsed.map(({ nameUz, unit, fromQuantity, toQuantity, markedOutOfStock }) => ({
      nameUz,
      unit,
      fromQuantity,
      toQuantity,
      markedOutOfStock,
    })),
    reason,
  };
  const name = optionalText(recipientName);
  if (name !== undefined) alert.recipientName = name;
  return alert;
}

/**
 * Strictly validates an `order.status_changed` payload and converts it to a transport input.
 * Unknown extra keys are ignored (forward compatible); known keys must have the exact type.
 * @param {unknown} payload
 * @returns {import('./transport.js').OrderNotification | null} null when malformed
 */
export function parseOrderStatusPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const {
    order_id: orderId,
    order_number: orderNumber,
    status,
    locale,
    total_uzs: totalUzs,
    chat_id: chatId,
    cancel_reason: cancelReason,
  } = payload;
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) return null;
  if (
    typeof orderNumber !== 'string' ||
    orderNumber === '' ||
    Array.from(orderNumber).length > MAX_ORDER_NUMBER_CHARS
  ) {
    return null;
  }
  if (!isOrderStatus(status)) return null;
  if (locale !== 'uz' && locale !== 'ru') return null;
  if (typeof totalUzs !== 'number' || !Number.isSafeInteger(totalUzs) || totalUzs < 0) return null;
  if (
    typeof chatId !== 'number' ||
    !Number.isSafeInteger(chatId) ||
    chatId <= 0 ||
    chatId > MAX_TELEGRAM_ID
  ) {
    return null;
  }
  if (cancelReason !== undefined && typeof cancelReason !== 'string') return null;

  /** @type {import('./transport.js').OrderNotification} */
  const notification = { chatId, orderNumber, status, locale, totalUzs };
  if (cancelReason !== undefined) notification.cancelReason = cancelReason;
  return notification;
}

/**
 * Strictly validates an `order.staff_alert` payload. `chat_id` must be a group/supergroup id
 * (negative); `previous_status` is null for a new order. Unknown extra keys are ignored.
 *
 * `destination` (`{lat, lon}`, optional) is the delivery point of a `NEW` order; it only ever
 * becomes the Yandex Go button URL. It is validated strictly (finite numbers, WGS84 range), but a
 * bad or misplaced one (missing, malformed, or on any status other than `NEW`) only drops the
 * button: the alert text itself is what staff must not miss, so it is still delivered. Nothing
 * invalid can reach the URL. `recipient_name` (optional) and `details` (optional, `NEW` only: the
 * whole order) follow the same rule: a bad one is left out and the alert still goes.
 * @param {unknown} payload
 * @returns {import('./transport.js').StaffAlertNotification | null} null when malformed
 */
export function parseStaffAlertPayload(payload) {
  if (!isPlainObject(payload)) return null;
  const {
    order_id: orderId,
    order_number: orderNumber,
    status,
    previous_status: previousStatus,
    total_uzs: totalUzs,
    chat_id: chatId,
    cancelled_by_customer: cancelledByCustomer,
    recipient_name: recipientName,
    details,
    destination,
  } = payload;
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) return null;
  if (
    typeof orderNumber !== 'string' ||
    orderNumber === '' ||
    Array.from(orderNumber).length > MAX_ORDER_NUMBER_CHARS
  ) {
    return null;
  }
  if (!isOrderStatus(status)) return null;
  if (previousStatus !== null && !isOrderStatus(previousStatus)) return null;
  if (typeof totalUzs !== 'number' || !Number.isSafeInteger(totalUzs) || totalUzs < 0) return null;
  if (
    typeof chatId !== 'number' ||
    !Number.isSafeInteger(chatId) ||
    chatId >= 0 ||
    chatId < MIN_GROUP_CHAT_ID
  ) {
    return null;
  }
  if (typeof cancelledByCustomer !== 'boolean') return null;
  /** @type {import('./transport.js').StaffAlertNotification} */
  const alert = {
    kind: 'staff_alert',
    chatId,
    orderId,
    orderNumber,
    status,
    previousStatus,
    totalUzs,
    cancelledByCustomer,
  };
  const name = optionalText(recipientName);
  if (name !== undefined) alert.recipientName = name;
  const parsedDetails = status === 'NEW' ? parseStaffAlertDetails(details) : undefined;
  if (parsedDetails !== undefined) alert.details = parsedDetails;
  if (status === 'NEW' && isGeoPoint(destination)) {
    alert.destination = { lat: destination.lat, lon: destination.lon };
  }
  return alert;
}

/**
 * Parses the payload of a known event type; `undefined` for an unknown event type.
 * @param {unknown} eventType
 * @param {unknown} payload
 * @returns {import('./transport.js').Notification | null | undefined}
 */
function parseEvent(eventType, payload) {
  if (eventType === ORDER_STATUS_CHANGED) return parseOrderStatusPayload(payload);
  if (eventType === ORDER_STAFF_ALERT) return parseStaffAlertPayload(payload);
  if (eventType === ORDER_ADJUSTED) return parseOrderAdjustedPayload(payload);
  if (eventType === ORDER_STAFF_ADJUSTED) return parseStaffAdjustedPayload(payload);
  return undefined;
}

/**
 * Asks the transport to deliver; a throwing or misbehaving transport counts as a transient error.
 * @param {import('./transport.js').NotificationTransport} transport
 * @param {import('./transport.js').Notification} notification
 * @returns {Promise<{ outcome: import('../types.js').NotificationOutcome, errorCode?: string }>}
 */
async function deliverSafely(transport, notification) {
  /** @type {unknown} */
  let result;
  try {
    result = await transport.deliver(notification);
  } catch {
    return { outcome: 'retry', errorCode: 'transport_error' };
  }
  if (!isPlainObject(result) || !OUTCOMES.includes(/** @type {string} */ (result.outcome))) {
    return { outcome: 'retry', errorCode: 'transport_error' };
  }
  const outcome = /** @type {import('../types.js').NotificationOutcome} */ (result.outcome);
  const { errorCode } = result;
  return typeof errorCode === 'string' && ERROR_CODE_RE.test(errorCode)
    ? { outcome, errorCode }
    : { outcome };
}

/**
 * Parses the `claim` response. Throws `TypeError` (generic message) when the shape is wrong.
 * @param {unknown} response
 * @returns {{ items: unknown[], leaseExpiresAtMs: number }}
 */
function parseClaimResponse(response) {
  if (!isPlainObject(response) || !Array.isArray(response.items)) {
    throw new TypeError('Invalid claim response');
  }
  const leaseExpiresAtMs =
    typeof response.lease_expires_at === 'string' ? Date.parse(response.lease_expires_at) : NaN;
  return { items: response.items, leaseExpiresAtMs };
}

/**
 * Claims due notifications from the Core API, delivers them one by one through `transport` and
 * reports each outcome. Run it with a limited budget of time: it makes up to
 * `maxBatches * limit` sequential deliveries.
 *
 * Behaviour:
 * - `order.status_changed`, `order.staff_alert`, `order.adjusted` and `order.staff_adjusted` are
 *   delivered through the transport.
 * - unknown `event_type` -> reported `failed` / `unknown_event`; malformed payload -> `failed` /
 *   `invalid_payload`. Neither reaches the transport.
 * - Delivery is sequential. Before each delivery the remaining lease is checked; with less than
 *   `LEASE_SAFETY_MARGIN_MS` (10 s) left, the rest of the batch is NOT touched (counted in
 *   `skipped`) and the drain stops: the Core API redelivers those after the lease expires. The
 *   lease end is the earlier of the server's `lease_expires_at` and `LEASE_MS` after the claim
 *   response arrived locally, which keeps a slow local clock from over-trusting the lease.
 * - A failed report (network, 404 because the lease was lost, ...) never stops the batch; it is
 *   counted in `reportFailed`.
 * - More batches are claimed (up to `maxBatches`) only while a batch came back full and was
 *   processed completely.
 * - If the claim call itself fails, it rejects with the `CoreApiError` when it is the first claim;
 *   after at least one batch the drain stops and returns what it has.
 *
 * @param {object} deps
 * @param {OutboxCoreApi} deps.coreApi
 * @param {import('./transport.js').NotificationTransport} deps.transport
 * @param {number} [deps.limit] messages per claim, integer 1..50 (default 20)
 * @param {number} [deps.maxBatches] claims per drain, integer >= 1 (default 1)
 * @param {() => number} [deps.now] epoch milliseconds
 * @returns {Promise<DrainSummary>}
 */
export async function drainOrderNotifications({
  coreApi,
  transport,
  limit = DEFAULT_LIMIT,
  maxBatches = 1,
  now = Date.now,
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid limit');
  if (!Number.isInteger(maxBatches) || maxBatches < 1) throw new TypeError('Invalid maxBatches');

  /** @type {DrainSummary} */
  const summary = {
    claimed: 0,
    delivered: 0,
    blocked: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    reportFailed: 0,
  };

  /**
   * @param {string} id
   * @param {number} attempt the claim's `attempts` (the lease's fencing token)
   * @param {import('../types.js').NotificationOutcome} outcome
   * @param {string} [errorCode]
   */
  async function report(id, attempt, outcome, errorCode) {
    if (outcome === 'delivered') summary.delivered += 1;
    else if (outcome === 'recipient_blocked') summary.blocked += 1;
    else if (outcome === 'retry') summary.retried += 1;
    else summary.failed += 1;
    try {
      await coreApi.reportNotification(
        id,
        errorCode === undefined ? { attempt, outcome } : { attempt, outcome, errorCode },
      );
    } catch {
      summary.reportFailed += 1;
    }
  }

  for (let batch = 0; batch < maxBatches; batch += 1) {
    /** @type {{ items: unknown[], leaseExpiresAtMs: number }} */
    let claimed;
    try {
      claimed = parseClaimResponse(await coreApi.claimNotifications({ limit }));
    } catch (error) {
      if (batch === 0) throw error;
      break;
    }
    const claimedAt = now();
    // `NaN` (unparseable lease) falls back to the nominal lease length.
    const leaseEnd = Math.min(
      Number.isNaN(claimed.leaseExpiresAtMs) ? Infinity : claimed.leaseExpiresAtMs,
      claimedAt + LEASE_MS,
    );
    summary.claimed += claimed.items.length;

    let leaseRunningOut = false;
    for (const item of claimed.items) {
      const id = isPlainObject(item) ? item.id : undefined;
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        // Cannot be reported without a valid id; the Core API redelivers it after the lease.
        summary.skipped += 1;
        continue;
      }
      const attempt = /** @type {Record<string, unknown>} */ (item).attempts;
      if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
        // Without the claim's attempt the report would be refused; leave it to the lease.
        summary.skipped += 1;
        continue;
      }
      if (leaseRunningOut || leaseEnd - now() < LEASE_SAFETY_MARGIN_MS) {
        leaseRunningOut = true;
        summary.skipped += 1;
        continue;
      }
      const notification = parseEvent(
        /** @type {Record<string, unknown>} */ (item).event_type,
        /** @type {Record<string, unknown>} */ (item).payload,
      );
      if (notification === undefined) {
        await report(id, attempt, 'failed', 'unknown_event');
        continue;
      }
      if (notification === null) {
        await report(id, attempt, 'failed', 'invalid_payload');
        continue;
      }
      const result = await deliverSafely(transport, notification);
      await report(id, attempt, result.outcome, result.errorCode);
    }

    if (leaseRunningOut || claimed.items.length < limit) break;
  }
  return summary;
}
