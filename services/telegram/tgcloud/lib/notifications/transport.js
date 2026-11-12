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
import { buildOrderStatusMessage, sendOrderStatusNotification } from './orderStatus.js';
import { buildStaffAlertMessage } from './staffAlert.js';
import { yandexGoCourierUrl } from './yandexGo.js';

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
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {import('../types.js').OrderStatus | null} previousStatus
 * @property {number} totalUzs integer amount in UZS
 * @property {boolean} cancelledByCustomer
 * @property {import('./yandexGo.js').GeoPoint} [destination] delivery point of a NEW order; adds
 *   the Yandex Go courier button
 */

/**
 * Anything the drain hands to a transport.
 * @typedef {OrderNotification | StaffAlertNotification} Notification
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
 * Builds the staff alert text, or throws `TypeError` when the alert is unusable.
 * @param {StaffAlertNotification} alert
 * @returns {string}
 */
function staffAlertText(alert) {
  if (!Number.isSafeInteger(alert.chatId) || alert.chatId >= 0) {
    throw new TypeError('Invalid group chat id');
  }
  return buildStaffAlertMessage(alert).text;
}

/**
 * The `sendMessage` parameters of a staff alert: the plain text, plus a one-button inline keyboard
 * (a URL button: Telegram opens it, the bot receives no callback) when the alert carries a valid
 * destination. Throws `TypeError` when the alert is unusable.
 * @param {StaffAlertNotification} alert
 * @returns {Record<string, unknown>}
 */
export function staffAlertParams(alert) {
  /** @type {Record<string, unknown>} */
  const params = { chat_id: alert.chatId, text: staffAlertText(alert) };
  const url = alert.destination === undefined ? null : yandexGoCourierUrl(alert.destination);
  if (url !== null) {
    params.reply_markup = {
      inline_keyboard: [[{ text: STAFF_MESSAGES.staffAlert.courierButton, url }]],
    };
  }
  return params;
}

/**
 * Sends a staff alert. Bot API 403 means the bot was removed from (or muted in) the group: final,
 * reported as `recipient_blocked`, like a customer who blocked the bot.
 * @param {{ sendMessage: (params: Record<string, unknown>) => Promise<unknown> }} api
 * @param {StaffAlertNotification} alert
 * @returns {Promise<DeliveryResult>}
 */
async function deliverStaffAlert(api, alert) {
  /** @type {Record<string, unknown>} */
  let params;
  try {
    params = staffAlertParams(alert);
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
 * Bot API transport: customer notifications via `sendOrderStatusNotification`, staff alerts via
 * `buildStaffAlertMessage` + `api.sendMessage` (both plain text, no `parse_mode`; a staff alert
 * with a destination also gets the Yandex Go courier URL button).
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
 * @param {{ api: { sendMessage: (params: Record<string, unknown>) => Promise<unknown> } }} deps
 * @returns {NotificationTransport}
 */
export function createTelegramBotTransport({ api }) {
  return {
    async deliver(notification) {
      if (notification?.kind === 'staff_alert') return deliverStaffAlert(api, notification);
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
