// @ts-check
/**
 * Staff group alert (`order.staff_alert` outbox event, ADR 0008/0015): one bilingual PLAIN TEXT
 * message per important order change, posted to the group connected with `/connect_orders`.
 *
 * It carries only what staff need to spot the order in the admin: order number, status (with the
 * previous status when known), total, and whether the customer cancelled it. No customer name,
 * phone or address ever reaches the group.
 */
import { STAFF_MESSAGES, isOrderStatus } from '../i18n.js';
import { formatUzs, isOrderNumber } from './orderStatus.js';

const NBSP = ' ';

/**
 * @typedef {object} StaffAlertInput
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {import('../types.js').OrderStatus | null} [previousStatus]
 * @property {number} totalUzs integer amount in UZS
 * @property {boolean} [cancelledByCustomer]
 */

/**
 * @typedef {object} StaffAlertTexts
 * @property {Readonly<Record<'NEW' | 'CANCELLED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'other', string>>} headline
 * @property {string} statusLabel
 * @property {string} totalLabel
 * @property {string} currency
 * @property {string} cancelledByCustomer
 * @property {Readonly<Record<import('../types.js').OrderStatus, string>>} status
 */

/**
 * @param {StaffAlertTexts} lang
 * @param {StaffAlertInput} input
 * @returns {string[]}
 */
function block(lang, { orderNumber, status, previousStatus, totalUzs, cancelledByCustomer }) {
  const headline =
    status === 'NEW' ||
    status === 'CANCELLED' ||
    status === 'OUT_FOR_DELIVERY' ||
    status === 'DELIVERED'
      ? lang.headline[status]
      : lang.headline.other;
  const statusText =
    previousStatus && previousStatus !== status
      ? `${lang.status[previousStatus]} → ${lang.status[status]}`
      : lang.status[status];
  const lines = [
    `${headline} №${orderNumber}`,
    `${lang.statusLabel}: ${statusText}`,
    `${lang.totalLabel}: ${formatUzs(totalUzs)}${NBSP}${lang.currency}`,
  ];
  if (cancelledByCustomer === true) lines.push(lang.cancelledByCustomer);
  return lines;
}

/**
 * Builds the staff alert text: Uzbek block, blank line, Russian block. Send WITHOUT `parse_mode`.
 *
 * @param {StaffAlertInput} input
 * @returns {{ text: string }}
 * @throws {TypeError} for an unknown status, malformed order number or invalid amount
 */
export function buildStaffAlertMessage(input) {
  if (!isOrderStatus(input.status)) throw new TypeError('Unknown order status');
  if (
    input.previousStatus !== undefined &&
    input.previousStatus !== null &&
    !isOrderStatus(input.previousStatus)
  ) {
    throw new TypeError('Unknown previous order status');
  }
  if (!isOrderNumber(input.orderNumber)) throw new TypeError('Invalid order number');
  const uz = block(STAFF_MESSAGES.staffAlert.uz, input);
  const ru = block(STAFF_MESSAGES.staffAlert.ru, input);
  return { text: `${uz.join('\n')}\n\n${ru.join('\n')}` };
}
