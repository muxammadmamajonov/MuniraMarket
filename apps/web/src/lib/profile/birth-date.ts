/**
 * Birthday entry: typed as `DD.MM.YYYY` (the dots are inserted for the customer) or picked in the
 * native date picker; stored by the Core API as an ISO `YYYY-MM-DD`. The same bounds as the API:
 * not before 1900-01-01 and not after today in Tashkent.
 */

export const MIN_BIRTH_DATE = '1900-01-01';
const TASHKENT_TZ = 'Asia/Tashkent';

/** Today's calendar date in Tashkent as `YYYY-MM-DD` (the shop's day, not the device's). */
export function tashkentToday(now: Date = new Date()): string {
  // `en-CA` formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TASHKENT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Re-formats the field after any edit: digits only, a dot inserted before the 3rd and 5th digit.
 * A dot is never added after the last digit, so deleting backwards never gets stuck on one.
 */
export function maskBirthDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(
    (part) => part !== '',
  );
  return parts.join('.');
}

/** `2001-03-09` -> `09.03.2001`; anything else -> empty. */
export function isoToDisplay(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return match === null ? '' : `${match[3]}.${match[2]}.${match[1]}`;
}

export type BirthDateError = 'incomplete' | 'invalid' | 'future' | 'tooOld';

export type BirthDateParse =
  { ok: true; iso: string | null } | { ok: false; error: BirthDateError };

/**
 * Reads the typed `DD.MM.YYYY`. Empty means "no birthday" (`iso: null`). A real calendar date is
 * required (no 31.02), within {@link MIN_BIRTH_DATE} .. today.
 */
export function parseBirthDate(display: string, today: string = tashkentToday()): BirthDateParse {
  const trimmed = display.trim();
  if (trimmed === '') return { ok: true, iso: null };
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (match === null) return { ok: false, error: 'incomplete' };
  const [, dd, mm, yyyy] = match as unknown as [string, string, string, string];
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, error: 'invalid' };
  }
  const iso = `${yyyy}-${mm}-${dd}`;
  // ISO dates compare correctly as strings.
  if (iso < MIN_BIRTH_DATE) return { ok: false, error: 'tooOld' };
  if (iso > today) return { ok: false, error: 'future' };
  return { ok: true, iso };
}
