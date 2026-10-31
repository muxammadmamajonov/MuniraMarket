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
import { buildOrderStatusMessage, sendOrderStatusNotification } from './orderStatus.js';

/**
 * A validated order status notification, as handed to a transport.
 * @typedef {object} OrderNotification
 * @property {number} chatId Telegram chat id (a private chat: the user's Telegram id)
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {string} [locale] `uz` | `ru`
 * @property {number} [totalUzs] integer amount in UZS
 * @property {string} [cancelReason] customer-safe text; shown only for CANCELLED
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
 * @property {(notification: OrderNotification) => Promise<DeliveryResult>} deliver
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
 * Bot API transport built on `sendOrderStatusNotification`.
 *
 * | Situation                                   | Result                                     |
 * | ------------------------------------------- | ------------------------------------------ |
 * | sent                                        | `delivered`                                |
 * | Bot API 403 (user blocked the bot)          | `recipient_blocked`                        |
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
