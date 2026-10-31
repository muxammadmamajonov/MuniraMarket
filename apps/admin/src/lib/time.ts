import { SHOP_TIME_ZONE } from './format';

/** Asia/Tashkent is UTC+05:00 all year (no DST), so a fixed offset is exact. */
export const TASHKENT_OFFSET = '+05:00';
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isHHMM(value: string): boolean {
  return HHMM.test(value);
}

export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** `HH:MM:SS` or `HH:MM` from the API -> `HH:MM`. */
export function toHHMM(value: string): string {
  return value.slice(0, 5);
}

/** Today's date in Tashkent as `YYYY-MM-DD`. */
export function todayInTashkent(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** `date` + `+n` days, `YYYY-MM-DD` (calendar arithmetic, independent of the browser zone). */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** `2026-11-02` + `14:00` -> `2026-11-02T14:00:00+05:00`. */
export function tashkentIso(date: string, time: string): string {
  return `${date}T${time}:00${TASHKENT_OFFSET}`;
}

/**
 * The default order cut-off of a slot: two hours before it starts, as a `datetime-local` value
 * (`YYYY-MM-DDTHH:MM`, Tashkent wall-clock). Empty when date or time is not valid yet.
 */
export function defaultCutoff(date: string, startsAt: string): string {
  if (!isIsoDate(date) || !isHHMM(startsAt)) return '';
  const start = Date.parse(`${date}T${startsAt}:00Z`);
  return new Date(start - 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** A `datetime-local` value (Tashkent wall-clock) as an ISO string with the +05:00 offset. */
export function cutoffToIso(local: string): string {
  return `${local.length === 16 ? `${local}:00` : local}${TASHKENT_OFFSET}`;
}

/** An API timestamp as a Tashkent `datetime-local` value. */
export function isoToCutoff(iso: string): string {
  const moved = new Date(Date.parse(iso) + TASHKENT_OFFSET_MS);
  return Number.isNaN(moved.getTime()) ? '' : moved.toISOString().slice(0, 16);
}

export { SHOP_TIME_ZONE };
