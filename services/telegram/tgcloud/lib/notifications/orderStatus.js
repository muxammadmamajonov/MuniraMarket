// @ts-check
/**
 * Order status notification adapter (message formatting + delivery through the Bot API).
 *
 * Delivery path: Core API writes a transactional outbox row for every status change (ADR 0008);
 * `drainOrderNotifications` (`./outbox.js`) claims rows and hands each one to a transport
 * (`./transport.js`), which calls `sendOrderStatusNotification` below. The trigger that runs the
 * drain is NOT wired yet: no handler or endpoint calls it. See services/telegram/README.md.
 */
import { BotApiError } from 'sdk';
import { isOrderStatus, messagesFor, pickLocale } from '../i18n.js';

const NBSP = ' ';
const MAX_REASON_CHARS = 200;
const ORDER_NUMBER_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

/**
 * Formats a non-negative integer amount of UZS with U+00A0 as the thousands separator.
 * @param {number} amount
 * @returns {string}
 */
export function formatUzs(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError('totalUzs must be a non-negative integer');
  }
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/**
 * Collapses whitespace/control characters and caps the length (by code point).
 * @param {string} reason
 * @returns {string}
 */
function cleanReason(reason) {
  const collapsed = reason
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(collapsed);
  return chars.length > MAX_REASON_CHARS
    ? `${chars.slice(0, MAX_REASON_CHARS - 1).join('')}…`
    : collapsed;
}

/**
 * @typedef {object} OrderStatusInput
 * @property {string} orderNumber customer-facing order number
 * @property {import('../types.js').OrderStatus} status
 * @property {string} [locale] `uz` | `ru` (anything else falls back to `uz`)
 * @property {number} [totalUzs] integer amount in UZS
 * @property {string} [cancelReason] customer-safe text; shown only for CANCELLED
 */

/**
 * Builds the notification text. The result is PLAIN TEXT: it must be sent without `parse_mode`,
 * so no markup escaping is needed and values cannot inject formatting.
 *
 * @param {OrderStatusInput} input
 * @returns {{ text: string }}
 * @throws {TypeError} for an unknown status, malformed order number or invalid amount
 */
export function buildOrderStatusMessage({ orderNumber, status, locale, totalUzs, cancelReason }) {
  if (!isOrderStatus(status)) throw new TypeError('Unknown order status');
  if (typeof orderNumber !== 'string' || !ORDER_NUMBER_RE.test(orderNumber)) {
    throw new TypeError('Invalid order number');
  }
  const messages = messagesFor(pickLocale(locale));

  const lines = [`${messages.orderStatus[status]}`, `${messages.orderLabel} №${orderNumber}`];
  if (totalUzs !== undefined) {
    lines.push(`${messages.totalLabel}: ${formatUzs(totalUzs)}${NBSP}${messages.currency}`);
  }
  if (status === 'CANCELLED' && cancelReason !== undefined) {
    const reason = cleanReason(cancelReason);
    if (reason !== '') lines.push(`${messages.cancelReasonLabel}: ${reason}`);
  }
  return { text: lines.join('\n') };
}

/**
 * Sends an order status notification. A user who blocked the bot (Bot API 403) is an expected
 * condition and returns `{ delivered: false, reason: 'blocked' }`; all other failures are rethrown
 * so the caller can retry.
 *
 * @param {OrderStatusInput & { api: { sendMessage: (params: Record<string, unknown>) => Promise<unknown> }, chatId: number }} input
 * @returns {Promise<{ delivered: true, result: unknown } | { delivered: false, reason: 'blocked' }>}
 */
export async function sendOrderStatusNotification({ api, chatId, ...order }) {
  if (!Number.isSafeInteger(chatId) || chatId === 0) throw new TypeError('Invalid chat id');
  const { text } = buildOrderStatusMessage(order);
  try {
    const result = await api.sendMessage({ chat_id: chatId, text });
    return { delivered: true, result };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 403) {
      return { delivered: false, reason: 'blocked' };
    }
    throw error;
  }
}
