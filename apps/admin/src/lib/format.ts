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
