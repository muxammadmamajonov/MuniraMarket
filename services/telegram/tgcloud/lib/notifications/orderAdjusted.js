// @ts-check
/**
 * "Your order changed" customer message (`order.adjusted` outbox event, ADR 0018): staff lowered
 * one or more lines because the goods were not there. In the customer's language (uz / ru), PLAIN
 * TEXT (sent without `parse_mode`, so names cannot inject formatting): which items changed, the
 * new total, and that the order can be cancelled in the app if it is no longer wanted. The staff's
 * reason is never shown to the customer.
 */
import { messagesFor, pickLocale } from '../i18n.js';
import { formatUzs, isOrderNumber } from './orderStatus.js';

const NBSP = '\u00a0';
const MAX_NAME_CHARS = 120;
/** Telegram's maximum message length. */
const TEXT_LIMIT = 4096;

/**
 * @typedef {object} AdjustedChange
 * @property {string} nameUz
 * @property {string} nameRu
 * @property {import('../types.js').Unit} unit
 * @property {number} fromQuantity
 * @property {number} toQuantity
 */

/**
 * @typedef {object} OrderAdjustedInput
 * @property {string} orderNumber
 * @property {string} [locale] `uz` | `ru` (anything else falls back to `uz`)
 * @property {number} totalUzs the order's new total
 * @property {AdjustedChange[]} changes
 */

/**
 * @param {string} value
 * @returns {string}
 */
function cleanName(value) {
  const collapsed = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(collapsed);
  return chars.length > MAX_NAME_CHARS
    ? `${chars.slice(0, MAX_NAME_CHARS - 1).join('')}…`
    : collapsed;
}

/**
 * Builds the customer's message. Send WITHOUT `parse_mode`.
 *
 * @param {OrderAdjustedInput} input
 * @returns {{ text: string }}
 * @throws {TypeError} for a malformed order number, invalid amount or no changes
 */
export function buildOrderAdjustedMessage({ orderNumber, locale, totalUzs, changes }) {
  if (!isOrderNumber(orderNumber)) throw new TypeError('Invalid order number');
  if (!Array.isArray(changes) || changes.length === 0) throw new TypeError('No changes');
  const lang = pickLocale(locale);
  const m = messagesFor(lang);
  const lines = changes.map((change) => {
    const name = cleanName(lang === 'ru' ? change.nameRu : change.nameUz);
    const unit = m.units[change.unit] ?? change.unit;
    return (
      `• ${name}: ${change.fromQuantity}${NBSP}${unit} → ` + `${change.toQuantity}${NBSP}${unit}`
    );
  });
  const head = [m.orderAdjusted, `${m.orderLabel} №${orderNumber}`, m.adjustedIntro];
  const tail = [
    `${m.newTotalLabel}: ${formatUzs(totalUzs)}${NBSP}${m.currency}`,
    '',
    m.adjustedCancelHint,
  ];
  for (let shown = lines.length; shown >= 1; shown -= 1) {
    const listed = lines.slice(0, shown);
    if (shown < lines.length) listed.push(`+${lines.length - shown}`);
    const message = [...head, ...listed, ...tail].join('\n');
    if (message.length <= TEXT_LIMIT) return { text: message };
  }
  return { text: [...head, ...tail].join('\n') };
}
