// @ts-check
/**
 * Notification transport: the seam between the outbox drain (`./outbox.js`) and whatever actually
 * sends the message. The drain only knows `NotificationTransport`; `createTelegramBotTransport`
 * is the Bot API implementation. No credentials live here: the SDK `api` is already bound to the
 * bot by the platform.
 *
 * Error codes returned here end up in the Core API outbox row. They are short machine codes
 * (`bot_api_429`, `invalid_payload`, `transport_error`) and NEVER contain message text, chat ids,
 * order data, or Bot API descriptions.
 */
import { BotApiError } from 'sdk';
import { STAFF_MESSAGES } from '../i18n.js';
import { buildOrderAdjustedMessage } from './orderAdjusted.js';
import { buildOrderStatusMessage, sendOrderStatusNotification } from './orderStatus.js';
import { buildStaffAdjustedMessage, buildStaffAlertMessage } from './staffAlert.js';
import { yandexGoCourierUrl } from './yandexGo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An `https://` origin: scheme, host, optional port; no path, query or credentials. */
const HTTPS_ORIGIN_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;

/**
 * A validated order status notification for the customer, as handed to a transport.
 * @typedef {object} OrderNotification
 * @property {'order_status'} [kind] absent or `order_status`
 * @property {number} chatId Telegram chat id (a private chat: the user's Telegram id)
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {string} [locale] `uz` | `ru`
 * @property {number} [totalUzs] integer amount in UZS
 * @property {string} [cancelReason] customer-safe text; shown only for CANCELLED
 */

/**
 * A validated staff group alert (`order.staff_alert`), as handed to a transport.
 * @typedef {object} StaffAlertNotification
 * @property {'staff_alert'} kind
 * @property {number} chatId negative group/supergroup chat id
 * @property {string} [orderId] the order's id (for the "open in the admin" button)
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {import('../types.js').OrderStatus | null} previousStatus
 * @property {number} totalUzs integer amount in UZS
 * @property {boolean} cancelledByCustomer
 * @property {string} [recipientName]
 * @property {import('./staffAlert.js').StaffAlertDetails} [details] the whole order (NEW only)
 * @property {import('./yandexGo.js').GeoPoint} [destination] delivery point of a NEW order; adds
 *   the Yandex Go courier button
 */

/**
 * A validated "your order changed" customer message (`order.adjusted`, ADR 0018).
 * @typedef {object} OrderAdjustedNotification
 * @property {'order_adjusted'} kind
 * @property {number} chatId the customer's private chat
 * @property {string} orderNumber
 * @property {string} locale `uz` | `ru`
 * @property {number} totalUzs the order's new total
 * @property {import('./orderAdjusted.js').AdjustedChange[]} changes
 */

/**
 * A validated staff alert for lines lowered at picking (`order.staff_adjusted`, ADR 0018).
 * @typedef {object} StaffAdjustedNotification
 * @property {'staff_adjusted'} kind
 * @property {number} chatId negative group/supergroup chat id
 * @property {string} [orderId]
 * @property {string} orderNumber
 * @property {number} totalUzs the order's new total
 * @property {string} [recipientName]
 * @property {import('./staffAlert.js').StaffAdjustedChange[]} changes
 * @property {string} reason
 */

/**
 * Anything the drain hands to a transport.
 * @typedef {OrderNotification | StaffAlertNotification | OrderAdjustedNotification | StaffAdjustedNotification} Notification
 */

/**
 * What a transport reports for one notification. `errorCode` matches `^[a-z0-9_.-]{1,64}$`.
 * @typedef {object} DeliveryResult
 * @property {import('../types.js').NotificationOutcome} outcome
 *   `delivered`: sent. `recipient_blocked`: the user blocked the bot (final, not an error).
 *   `retry`: transient, the Core API backs off and redelivers. `failed`: permanent.
 * @property {string} [errorCode]
 */

/**
 * Contract of a transport. `deliver` must not throw for delivery problems: it resolves with a
 * `DeliveryResult` (the drain still treats a rejection as `retry` / `transport_error`).
 *
 * @typedef {object} NotificationTransport
 * @property {(notification: Notification) => Promise<DeliveryResult>} deliver
 */

/** @param {number} code */
function botApiCode(code) {
  return `bot_api_${code}`;
}

/**
 * @param {unknown} error
 * @returns {DeliveryResult}
 */
function classifySendError(error) {
  if (error instanceof BotApiError && Number.isInteger(error.code)) {
    const code = error.code;
    // 429 (flood control) and 5xx are transient. 401 means the bot token is wrong or was rotated:
    // a configuration fault that must not discard the message. Other 4xx will not succeed later.
    if (code === 401 || code === 429 || code >= 500) {
      return { outcome: 'retry', errorCode: botApiCode(code) };
    }
    if (code >= 400) return { outcome: 'failed', errorCode: botApiCode(code) };
  }
  // Network failures and anything unexpected: try again later.
  return { outcome: 'retry', errorCode: 'transport_error' };
}

/**
 * Checks everything that would make a send impossible, before touching the API, so that a
 * `TypeError` raised later can only be an unexpected runtime problem.
 * @param {OrderNotification} notification
 */
function assertDeliverable(notification) {
  const { chatId, ...order } = notification;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new TypeError('Invalid chat id');
  buildOrderStatusMessage(order);
}

/**
 * The admin's page of an order (`<origin>/uz/orders/<id>`), or `null` when the admin origin is
 * unknown or not `https://` (Telegram refuses URL buttons to localhost and plain http hosts, and
 * the button would make the whole message fail) or the id is not a UUID.
 * @param {string | undefined} adminOrigin
 * @param {string | undefined} orderId
 * @returns {string | null}
 */
export function adminOrderUrl(adminOrigin, orderId) {
  if (typeof adminOrigin !== 'string' || typeof orderId !== 'string') return null;
  const origin = adminOrigin.replace(/\/+$/, '');
  if (!HTTPS_ORIGIN_RE.test(origin) || !UUID_RE.test(orderId)) return null;
  return `${origin}/uz/orders/${orderId.toLowerCase()}`;
}

/**
 * URL buttons under a staff message (Telegram opens them; the bot receives no callback): "Yandex
 * chaqirish" when there is a valid destination, "Adminda ochish" when the admin origin is known.
 * @param {{ destination?: import('./yandexGo.js').GeoPoint | undefined, orderId?: string | undefined }} message
 * @param {string | undefined} adminOrigin
 * @returns {Record<string, unknown> | undefined}
 */
function staffButtons(message, adminOrigin) {
  const row = [];
  const courier =
    message.destination === undefined ? null : yandexGoCourierUrl(message.destination);
  if (courier !== null) row.push({ text: STAFF_MESSAGES.staffAlert.courierButton, url: courier });
  const admin = adminOrderUrl(adminOrigin, message.orderId);
  if (admin !== null) row.push({ text: STAFF_MESSAGES.staffAlert.adminButton, url: admin });
  return row.length === 0 ? undefined : { inline_keyboard: [row] };
}

/** @param {number} chatId */
function assertGroupChat(chatId) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0) throw new TypeError('Invalid group chat id');
}

/**
 * The `sendMessage` parameters of a staff alert: the Telegram HTML text (`parse_mode: 'HTML'`,
 * every value escaped), plus URL buttons (`staffButtons`). Throws `TypeError` when the alert is
 * unusable.
 * @param {StaffAlertNotification} alert
 * @param {{ adminOrigin?: string | undefined }} [options]
 * @returns {Record<string, unknown>}
 */
export function staffAlertParams(alert, { adminOrigin } = {}) {
  assertGroupChat(alert.chatId);
  const { text, parseMode } = buildStaffAlertMessage(alert);
  /** @type {Record<string, unknown>} */
  const params = { chat_id: alert.chatId, text, parse_mode: parseMode };
  const buttons = staffButtons(alert, adminOrigin);
  if (buttons !== undefined) params.reply_markup = buttons;
  return params;
}

/**
 * The `sendMessage` parameters of a "lines lowered at picking" staff alert (HTML, admin button).
 * @param {StaffAdjustedNotification} alert
 * @param {{ adminOrigin?: string | undefined }} [options]
 * @returns {Record<string, unknown>}
 */
export function staffAdjustedParams(alert, { adminOrigin } = {}) {
  assertGroupChat(alert.chatId);
  const { text, parseMode } = buildStaffAdjustedMessage(alert);
  /** @type {Record<string, unknown>} */
  const params = { chat_id: alert.chatId, text, parse_mode: parseMode };
  const buttons = staffButtons({ orderId: alert.orderId }, adminOrigin);
  if (buttons !== undefined) params.reply_markup = buttons;
  return params;
}

/**
 * The `sendMessage` parameters of a customer's "your order changed" message (plain text).
 * @param {OrderAdjustedNotification} message
 * @returns {Record<string, unknown>}
 */
export function orderAdjustedParams(message) {
  if (!Number.isSafeInteger(message.chatId) || message.chatId <= 0) {
    throw new TypeError('Invalid chat id');
  }
  return { chat_id: message.chatId, text: buildOrderAdjustedMessage(message).text };
}

/**
 * Sends prepared `sendMessage` parameters. Bot API 403 means the customer blocked the bot, or the
 * bot was removed from (or muted in) the staff group: final, reported as `recipient_blocked`.
 * @param {{ sendMessage: (params: Record<string, unknown>) => Promise<unknown> }} api
 * @param {() => Record<string, unknown>} prepare throws `TypeError` for an unusable message
 * @returns {Promise<DeliveryResult>}
 */
async function deliverPrepared(api, prepare) {
  /** @type {Record<string, unknown>} */
  let params;
  try {
    params = prepare();
  } catch {
    return { outcome: 'failed', errorCode: 'invalid_payload' };
  }
  try {
    await api.sendMessage(params);
    return { outcome: 'delivered' };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 403) return { outcome: 'recipient_blocked' };
    return classifySendError(error);
  }
}

/**
 * Bot API transport: customer notifications via `sendOrderStatusNotification` and
 * `buildOrderAdjustedMessage` (plain text, no `parse_mode`); staff alerts via
 * `buildStaffAlertMessage` / `buildStaffAdjustedMessage` (Telegram HTML) with URL buttons: the
 * Yandex Go courier button for a NEW order with a destination, and "Adminda ochish" when
 * `adminOrigin` (the admin's public `https://` origin) is given.
 *
 * | Situation                                   | Result                                     |
 * | ------------------------------------------- | ------------------------------------------ |
 * | sent                                        | `delivered`                                |
 * | Bot API 403 (user blocked the bot / bot     | `recipient_blocked`                        |
 * | removed from the staff group)               |                                            |
 * | Bot API 401, 429 or >= 500                  | `retry`, `bot_api_<code>`                  |
 * | any other Bot API 4xx (e.g. 400)            | `failed`, `bot_api_<code>`                 |
 * | malformed notification (TypeError)          | `failed`, `invalid_payload`                |
 * | anything else (network, unexpected error)   | `retry`, `transport_error`                 |
 *
 * @param {{ api: { sendMessage: (params: Record<string, unknown>) => Promise<unknown> }, adminOrigin?: string | null }} deps
 * @returns {NotificationTransport}
 */
export function createTelegramBotTransport({ api, adminOrigin }) {
  const options = { adminOrigin: adminOrigin ?? undefined };
  return {
    async deliver(notification) {
      if (notification?.kind === 'staff_alert') {
        return deliverPrepared(api, () => staffAlertParams(notification, options));
      }
      if (notification?.kind === 'staff_adjusted') {
        return deliverPrepared(api, () => staffAdjustedParams(notification, options));
      }
      if (notification?.kind === 'order_adjusted') {
        return deliverPrepared(api, () => orderAdjustedParams(notification));
      }
      try {
        assertDeliverable(notification);
      } catch {
        return { outcome: 'failed', errorCode: 'invalid_payload' };
      }
      try {
        const result = await sendOrderStatusNotification({ api, ...notification });
        return result.delivered ? { outcome: 'delivered' } : { outcome: 'recipient_blocked' };
      } catch (error) {
        return classifySendError(error);
      }
    },
  };
}
