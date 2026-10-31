/** Orders are placed and delivered in Tashkent; every timestamp is shown in that time zone. */
export const DISPLAY_TIME_ZONE = 'Asia/Tashkent';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * `2026-10-31T21:30:00Z` -> `01.11.2026 02:30` (Asia/Tashkent, UTC+5, no daylight saving).
 *
 * The time zone comes from `Intl.DateTimeFormat`; the digits are assembled from its parts so the
 * result is the same in every runtime and does not depend on ICU having `uz` data. Returns an
 * empty string for an unparsable timestamp rather than "Invalid Date".
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const part = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part['day']}.${part['month']}.${part['year']} ${part['hour']}:${part['minute']}`;
}

/**
 * A booked delivery date, `2026-11-03` -> `03.11.2026`. Unlike the checkout picker (which says
 * "today" / "tomorrow") an order keeps its date, so the label stays true next week.
 */
export function formatSlotDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match === null ? date : `${match[3]}.${match[2]}.${match[1]}`;
}
