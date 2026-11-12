/**
 * The customer's own profile (`PATCH /me`): pure rules (port of services/api/app/domain/profile.py).
 *
 * - Phone: an Uzbekistan number typed by the customer. Python's whitespace, `-`, `(` and `)` are
 *   ignored; `+998XXXXXXXXX`, `998XXXXXXXXX` and the 9 national digits are accepted and stored as
 *   `+998XXXXXXXXX`. A typed number is never verified (only the shared Telegram contact is).
 * - Birth date: `YYYY-MM-DD`, from 1900-01-01 up to today in Asia/Tashkent.
 */
import { PHONE_SEPARATORS } from './checkout.ts';
import { tashkentDate } from './tashkentTime.ts';

export const MIN_BIRTH_DATE = '1900-01-01';

export const PROFILE_PHONE_MESSAGE =
  'phone must be an Uzbekistan number: +998 and 9 digits, or the 9 digits alone';
export const BIRTH_DATE_FORMAT_MESSAGE = 'birth_date must be a date in YYYY-MM-DD format';
export const BIRTH_DATE_RANGE_MESSAGE = 'birth_date must be between 1900-01-01 and today';

// ASCII digits only.
const PROFILE_PHONE_RE = /^(?:\+?998)?([0-9]{9})$/;
const BIRTH_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** `(90) 123-45-67` / `998901234567` / `+998 90 123 45 67` -> `+998901234567`; else RangeError. */
export function normalizeProfilePhone(raw: string): string {
  const match = PROFILE_PHONE_RE.exec(raw.replace(PHONE_SEPARATORS, ''));
  if (match === null) throw new RangeError(PROFILE_PHONE_MESSAGE);
  return `+998${match[1]}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A `YYYY-MM-DD` string naming a real calendar day (Python's `date.fromisoformat` on that
 * pattern: years 0001-9999), returned unchanged; RangeError otherwise.
 */
export function parseBirthDate(raw: unknown): string {
  const match = typeof raw === 'string' ? BIRTH_DATE_RE.exec(raw) : null;
  if (match === null) throw new RangeError(BIRTH_DATE_FORMAT_MESSAGE);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(BIRTH_DATE_FORMAT_MESSAGE);
  }
  return raw as string;
}

/** Today's Asia/Tashkent date as `YYYY-MM-DD` (from the wall clock, like the reference). */
export function tashkentToday(nowMs: number = Date.now()): string {
  return tashkentDate(nowMs / 1000);
}

/** `value` when it lies in 1900-01-01..`today` (inclusive, `YYYY-MM-DD`); RangeError otherwise. */
export function checkBirthDate(value: string, today: string): string {
  if (value < MIN_BIRTH_DATE || value > today) throw new RangeError(BIRTH_DATE_RANGE_MESSAGE);
  return value;
}
