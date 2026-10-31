// @ts-check
/**
 * Drain adapter for the Core API order-notification outbox (ADR 0008).
 *
 * Flow: `claimNotifications` leases a batch; each message is validated, handed to a transport, and
 * its outcome is reported back. Delivery is AT LEAST ONCE: a message whose result is not reported
 * before the lease expires (60 s) is redelivered, and a crash between "sent" and "reported" sends
 * it twice. Nothing in this module runs on its own: a handler/endpoint/trigger must call
 * `drainOrderNotifications`, and none does yet (see services/telegram/README.md).
 *
 * Everything is injected (Core API client, transport, clock); there are no globals, and nothing
 * from a payload (names, order numbers, chat ids) is ever logged or put into an error code.
 */
import { isOrderStatus } from '../i18n.js';

export const ORDER_STATUS_CHANGED = 'order.status_changed';
/** Lease length the Core API grants per claim. */
export const LEASE_MS = 60_000;
/** Stop delivering when less than this much of the lease is left, so reports still fit in. */
export const LEASE_SAFETY_MARGIN_MS = 10_000;
export const DEFAULT_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ORDER_NUMBER_CHARS = 32;
const MAX_TELEGRAM_ID = 2 ** 52;
const ERROR_CODE_RE = /^[a-z0-9_.-]{1,64}$/;
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
 * Asks the transport to deliver; a throwing or misbehaving transport counts as a transient error.
 * @param {import('./transport.js').NotificationTransport} transport
 * @param {import('./transport.js').OrderNotification} notification
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
      if (/** @type {Record<string, unknown>} */ (item).event_type !== ORDER_STATUS_CHANGED) {
        await report(id, attempt, 'failed', 'unknown_event');
        continue;
      }
      const notification = parseOrderStatusPayload(
        /** @type {Record<string, unknown>} */ (item).payload,
      );
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
