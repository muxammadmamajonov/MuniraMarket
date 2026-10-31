/** Time zone every timestamp is shown in: the shop and its couriers work in Tashkent time. */
export const SHOP_TIME_ZONE = 'Asia/Tashkent';

// `en-GB` + `formatToParts` gives numeric parts independent of the UI locale (ICU data for `uz` is
// not guaranteed everywhere); we assemble the string ourselves so uz and ru read the same.
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHOP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `2026-10-31T09:05:00Z` -> `31.10.2026 14:05` (Asia/Tashkent). Invalid input is returned as is. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(DATE_TIME.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts['day']}.${parts['month']}.${parts['year']} ${parts['hour']}:${parts['minute']}`;
}

/** `tel:` URL for a phone number: digits and a leading `+` only. `null` if nothing dialable. */
export function telHref(phone: string): string | null {
  const dialable = phone.trim().replace(/(?!^\+)[^\d]/g, '');
  return /\d/.test(dialable) ? `tel:${dialable}` : null;
}

const NBSP = ' ';

/** `1284` -> `1 284` (NBSP groups, so a count never wraps in the middle). Non-integers are returned as `String`. */
export function formatCount(value: number): string {
  if (!Number.isSafeInteger(value)) return String(value);
  const grouped = String(Math.abs(value)).replace(/\B(?=(\d{3})+$)/g, NBSP);
  return value < 0 ? `-${grouped}` : grouped;
}

/** `2026-10-31` -> `31.10.2026`. Anything else is returned as is. */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? isoDate : `${match[3]}.${match[2]}.${match[1]}`;
}

/** `14:00:00` or `14:00` -> `14:00`. */
export function formatTime(value: string): string {
  return value.slice(0, 5);
}

/** A booked/offered delivery window: `31.10.2026, 14:00–16:00`. */
export function formatSlotWindow(date: string, startsAt: string, endsAt: string): string {
  return `${formatDate(date)}, ${formatTime(startsAt)}–${formatTime(endsAt)}`;
}
