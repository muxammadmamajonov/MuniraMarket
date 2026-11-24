// @ts-check
/**
 * Staff group messages (`order.staff_alert` and `order.staff_adjusted` outbox events, ADR
 * 0008/0015/0018), posted to the shop's private staff group connected with `/connect_orders`.
 *
 * Uzbek, Telegram HTML (`parse_mode: 'HTML'`): every value that comes from a payload (names,
 * phone, address, comment, reason, product names) goes through `escapeHtml`, so nothing a
 * customer typed can add markup. A NEW order's alert carries the whole order on the owner's
 * request (items, totals, payment, recipient, phone, address, comment, time) so staff can act from
 * Telegram; other alerts are short (number, status, recipient, total). Every message stays within
 * Telegram's 4096-character limit: a long item list is cut and ends with "+N ta mahsulot".
 *
 * The delivery point never appears in the text: it only becomes the Yandex Go courier button URL
 * (`./yandexGo.js`, added by the transport).
 */
import { STAFF_MESSAGES, isOrderStatus } from '../i18n.js';
import { formatUzs, isOrderNumber } from './orderStatus.js';

/** Telegram's maximum message length (we count the HTML source, which is never shorter). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Uzbekistan has been UTC+5 all year since 1992 (no DST): no time zone database needed. */
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const NBSP = '\u00a0';
const MAX_NAME_CHARS = 120;
const MAX_FIELD_CHARS = 200;
const MAX_COMMENT_CHARS = 500;
const MAX_REASON_CHARS = 300;

const T = STAFF_MESSAGES.staffAlert;

/**
 * @typedef {object} StaffAlertItem
 * @property {string} nameUz
 * @property {number} quantity
 * @property {import('../types.js').Unit} unit
 * @property {number} lineTotalUzs
 */

/**
 * @typedef {object} StaffAlertAddress
 * @property {string} street
 * @property {string} house
 * @property {string | null} apartment
 * @property {string | null} entrance
 * @property {string | null} floor
 * @property {string | null} landmark
 */

/**
 * Everything a NEW order's alert shows (validated by the outbox parser).
 * @typedef {object} StaffAlertDetails
 * @property {StaffAlertItem[]} items
 * @property {number} subtotalUzs
 * @property {'cash_on_delivery' | 'card_on_delivery'} paymentMethod
 * @property {string} recipientPhone
 * @property {StaffAlertAddress} address
 * @property {string | null} comment
 * @property {string | null} createdAt ISO-8601 instant
 */

/**
 * @typedef {object} StaffAlertInput
 * @property {string} orderNumber
 * @property {import('../types.js').OrderStatus} status
 * @property {import('../types.js').OrderStatus | null} [previousStatus]
 * @property {number} totalUzs integer amount in UZS
 * @property {boolean} [cancelledByCustomer]
 * @property {string} [recipientName]
 * @property {StaffAlertDetails} [details] only for a NEW order
 */

/**
 * @typedef {object} StaffAdjustedChange
 * @property {string} nameUz
 * @property {import('../types.js').Unit} unit
 * @property {number} fromQuantity
 * @property {number} toQuantity
 * @property {boolean} markedOutOfStock
 */

/**
 * @typedef {object} StaffAdjustedInput
 * @property {string} orderNumber
 * @property {number} totalUzs the order's new total
 * @property {string} [recipientName]
 * @property {StaffAdjustedChange[]} changes
 * @property {string} reason
 */

/**
 * Escapes text for Telegram HTML (`&`, `<`, `>`; quotes too, for safety in any context).
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Collapses control characters (newlines too unless `multiline`) and runs of spaces, trims and
 * caps the length by code point (with `…`). Returns '' for nothing usable.
 * @param {string} value
 * @param {number} maxChars
 * @param {boolean} [multiline]
 * @returns {string}
 */
function clean(value, maxChars, multiline = false) {
  const collapsed = multiline
    ? value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
  const chars = Array.from(collapsed);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : collapsed;
}

/**
 * Escaped, cleaned text.
 * @param {string} value
 * @param {number} maxChars
 * @param {boolean} [multiline]
 */
function text(value, maxChars, multiline = false) {
  return escapeHtml(clean(value, maxChars, multiline));
}

/** @param {number} amount */
function money(amount) {
  return `${formatUzs(amount)}${NBSP}${T.currency}`;
}

/**
 * @param {number} quantity
 * @param {import('../types.js').Unit} unit
 */
function quantityOf(quantity, unit) {
  return `${quantity}${NBSP}${T.units[unit] ?? unit}`;
}

/**
 * `13.11.2026 15:05` in Tashkent time, or `null` for an unusable instant.
 * @param {string | null | undefined} iso
 * @returns {string | null}
 */
export function tashkentDateTime(iso) {
  if (typeof iso !== 'string') return null;
  const epoch = Date.parse(iso);
  if (!Number.isFinite(epoch)) return null;
  const local = new Date(epoch + TASHKENT_OFFSET_MS);
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${two(local.getUTCDate())}.${two(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ` +
    `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`
  );
}

/**
 * `Amir Temur ko‘chasi, 15-uy, 12-xonadon, 2-podyezd, 3-qavat` (escaped).
 * @param {StaffAlertAddress} address
 */
function addressLine(address) {
  /** @type {string[]} */
  const parts = [clean(address.street, MAX_FIELD_CHARS)];
  for (const key of /** @type {const} */ (['house', 'apartment', 'entrance', 'floor'])) {
    const value = address[key];
    const part = typeof value === 'string' ? clean(value, 32) : '';
    if (part !== '') parts.push(`${part}-${T.addressParts[key]}`);
  }
  return escapeHtml(parts.filter((part) => part !== '').join(', '));
}

/**
 * The longest message (first `k` lines of `list`, then "+N ta mahsulot") that fits the limit.
 * @param {(shown: string[]) => string} render renders the message around the shown lines
 * @param {string[]} list
 * @returns {string}
 */
function fitList(render, list) {
  for (let shown = list.length; shown >= 0; shown -= 1) {
    const lines = list.slice(0, shown);
    if (shown < list.length) lines.push(`<i>${escapeHtml(T.moreItems(list.length - shown))}</i>`);
    const message = render(lines);
    if (message.length <= TELEGRAM_TEXT_LIMIT) return message;
  }
  // Unreachable with validated input (every other field is capped); never exceed the limit.
  return render([]).slice(0, TELEGRAM_TEXT_LIMIT);
}

/**
 * @param {StaffAlertInput} input
 * @returns {string}
 */
function headline(input) {
  const { status } = input;
  const title =
    status === 'NEW' ||
    status === 'CANCELLED' ||
    status === 'OUT_FOR_DELIVERY' ||
    status === 'DELIVERED'
      ? T.headline[status]
      : T.headline.other;
  return `<b>${escapeHtml(title)} №${escapeHtml(input.orderNumber)}</b>`;
}

/**
 * @param {StaffAlertInput} input
 * @returns {string}
 */
function shortAlert(input) {
  const { status, previousStatus } = input;
  const statusText =
    previousStatus && previousStatus !== status
      ? `${T.status[previousStatus]} → ${T.status[status]}`
      : T.status[status];
  const lines = [headline(input), `${T.statusLabel}: ${escapeHtml(statusText)}`];
  const recipient = input.recipientName === undefined ? '' : clean(input.recipientName, 100);
  if (recipient !== '') lines.push(`${T.recipientLabel}: ${escapeHtml(recipient)}`);
  lines.push(`${T.totalLabel}: ${money(input.totalUzs)}`);
  if (input.cancelledByCustomer === true) lines.push(`<i>${T.cancelledByCustomer}</i>`);
  return lines.join('\n');
}

/**
 * @param {StaffAlertInput} input
 * @param {StaffAlertDetails} details
 * @returns {string}
 */
function detailedAlert(input, details) {
  const head = [headline(input)];
  const created = tashkentDateTime(details.createdAt);
  if (created !== null) head.push(`${T.createdLabel}: ${created}`);

  const items = details.items.map(
    (item, index) =>
      `${index + 1}. ${text(item.nameUz, MAX_NAME_CHARS)} — ` +
      `${quantityOf(item.quantity, item.unit)} — ${money(item.lineTotalUzs)}`,
  );

  /** @type {string[]} */
  const totals = [];
  if (details.subtotalUzs !== input.totalUzs) {
    totals.push(`${T.subtotalLabel}: ${money(details.subtotalUzs)}`);
  }
  totals.push(`<b>${T.totalLabel}: ${money(input.totalUzs)}</b>`);
  totals.push(`${T.paymentLabel}: ${T.payment[details.paymentMethod]}`);

  /** @type {string[]} */
  const recipient = [];
  const name = input.recipientName === undefined ? '' : text(input.recipientName, 100);
  if (name !== '') recipient.push(`<b>${T.recipientLabel}:</b> ${name}`);
  recipient.push(`<b>${T.phoneLabel}:</b> ${text(details.recipientPhone, 32)}`);
  recipient.push(`<b>${T.addressLabel}:</b> ${addressLine(details.address)}`);
  const landmark =
    details.address.landmark === null ? '' : text(details.address.landmark, MAX_FIELD_CHARS);
  if (landmark !== '') recipient.push(`<b>${T.landmarkLabel}:</b> ${landmark}`);
  const comment = details.comment === null ? '' : text(details.comment, MAX_COMMENT_CHARS, true);
  if (comment !== '') recipient.push(`<b>${T.commentLabel}:</b> ${comment}`);

  return fitList(
    (shown) =>
      [
        head.join('\n'),
        [`<b>${T.itemsLabel}:</b>`, ...shown].join('\n'),
        totals.join('\n'),
        recipient.join('\n'),
      ].join('\n\n'),
    items,
  );
}

/**
 * @param {StaffAlertInput} input
 */
function assertValid(input) {
  if (!isOrderStatus(input.status)) throw new TypeError('Unknown order status');
  if (
    input.previousStatus !== undefined &&
    input.previousStatus !== null &&
    !isOrderStatus(input.previousStatus)
  ) {
    throw new TypeError('Unknown previous order status');
  }
  if (!isOrderNumber(input.orderNumber)) throw new TypeError('Invalid order number');
  formatUzs(input.totalUzs);
}

/**
 * Builds a staff alert. Send with `parse_mode: 'HTML'` (the returned `parseMode`). A NEW order
 * with `details` gets the full order; anything else the short form.
 *
 * @param {StaffAlertInput} input
 * @returns {{ text: string, parseMode: 'HTML' }}
 * @throws {TypeError} for an unknown status, malformed order number or invalid amount
 */
export function buildStaffAlertMessage(input) {
  assertValid(input);
  const message =
    input.status === 'NEW' && input.details !== undefined
      ? detailedAlert(input, input.details)
      : shortAlert(input);
  return { text: message, parseMode: 'HTML' };
}

/**
 * Builds the staff alert for order lines lowered at picking (ADR 0018):
 * `Olma: 3 dona → 1 dona`, the reason, the recipient and the new total.
 *
 * @param {StaffAdjustedInput} input
 * @returns {{ text: string, parseMode: 'HTML' }}
 * @throws {TypeError} for a malformed order number or invalid amount
 */
export function buildStaffAdjustedMessage(input) {
  if (!isOrderNumber(input.orderNumber)) throw new TypeError('Invalid order number');
  formatUzs(input.totalUzs);
  const head = `<b>${escapeHtml(T.adjustedHeadline)} №${escapeHtml(input.orderNumber)}</b>`;
  const changes = input.changes.map((change) => {
    const line =
      `${text(change.nameUz, MAX_NAME_CHARS)}: ${quantityOf(change.fromQuantity, change.unit)}` +
      ` → ${quantityOf(change.toQuantity, change.unit)}`;
    return change.markedOutOfStock ? `${line} (${T.outOfStock})` : line;
  });
  const tail = [`${T.reasonLabel}: ${text(input.reason, MAX_REASON_CHARS, true)}`];
  const recipient = input.recipientName === undefined ? '' : text(input.recipientName, 100);
  if (recipient !== '') tail.push(`${T.recipientLabel}: ${recipient}`);
  tail.push(`<b>${T.newTotalLabel}: ${money(input.totalUzs)}</b>`);
  return {
    text: fitList((shown) => [head, ...shown, ...tail].join('\n'), changes),
    parseMode: 'HTML',
  };
}
