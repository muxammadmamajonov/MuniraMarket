/**
 * Uzbekistan phone numbers as the customer types them: a fixed `+998` prefix and nine national
 * digits, shown as `+998 90 123 45 67`. The Core API (`PATCH /me`) accepts the same nine digits
 * and stores `+998XXXXXXXXX`; this module only shapes the input and catches mistakes early.
 */

export const UZ_COUNTRY_CODE = '998';
export const UZ_NATIONAL_DIGITS = 9;
/** The fixed country prefix, shown before the field (never typed). */
export const UZ_PHONE_PREFIX = '+998 ';

/**
 * The national digits in `raw`, at most nine. A pasted `+998 90 …`, `998901234567` or
 * `8 90 …`-style number keeps only its last nine digits' worth after the country code.
 */
export function nationalDigits(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith(UZ_COUNTRY_CODE) && digits.length > UZ_NATIONAL_DIGITS) {
    digits = digits.slice(UZ_COUNTRY_CODE.length);
  }
  return digits.slice(0, UZ_NATIONAL_DIGITS);
}

/** `901234567` -> `90 123 45 67`; partial input is grouped as far as it goes. */
export function formatNational(national: string): string {
  const d = national.slice(0, UZ_NATIONAL_DIGITS);
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)]
    .filter((group) => group !== '')
    .join(' ');
}

/** `901234567` -> `+998 90 123 45 67`. */
export function formatUzPhone(national: string): string {
  return `${UZ_PHONE_PREFIX}${formatNational(national)}`.trimEnd();
}

/**
 * Re-formats the national part after any edit (typed, deleted or pasted). The `+998` prefix is
 * shown beside the field, not inside it, so the caret can never land in it; a pasted full number
 * (`+998 90 …`, `998901234567`) still reads correctly.
 */
export function maskUzPhoneInput(raw: string): string {
  return formatNational(nationalDigits(raw));
}

export type UzPhoneError = 'required' | 'incomplete' | 'invalid';

/** `null` when `national` is a complete, plausible mobile or city number. */
export function validateUzPhone(national: string): UzPhoneError | null {
  if (national.length === 0) return 'required';
  if (national.length < UZ_NATIONAL_DIGITS) return 'incomplete';
  // No operator or city code starts with 0 (or 1): that is a trunk prefix typed by habit.
  if (national.startsWith('0') || national.startsWith('1')) return 'invalid';
  return null;
}

/** The value sent to the API: `+998XXXXXXXXX`. */
export function toE164(national: string): string {
  return `+${UZ_COUNTRY_CODE}${national}`;
}
