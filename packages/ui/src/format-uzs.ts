import type { Locale } from '@muniramarket/contracts';

const NBSP = '\u00A0';

const CURRENCY_SUFFIX: Record<Locale, string> = {
  uz: 'so\u2018m',
  ru: 'сум',
};

/**
 * Formats an integer amount of UZS (so'm) for display.
 *
 * Deterministic on purpose: it does not use `Intl` because ICU data for `uz` is not guaranteed
 * to be present in every runtime (Node builds, Telegram WebViews, Cloudflare/Vercel edge).
 *
 * - Thousands are grouped with U+00A0 so a price never wraps in the middle.
 * - The currency suffix is joined with U+00A0. uz uses the suffix `so` + U+2018 + `m`, ru uses `сум`.
 *   Example: 12500 -> "12<NBSP>500<NBSP>so‘m" (uz).
 * - Amounts are whole so'm; fractions are rejected rather than silently rounded.
 *
 * @throws {RangeError} if `amount` is not a safe integer.
 */
export function formatUZS(amount: number, locale: Locale): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(
      `formatUZS expects a safe integer amount of UZS, received ${String(amount)}`,
    );
  }

  // `|| 0` normalises -0 (a safe integer) to 0 so we never render "-0".
  const absolute = Math.abs(amount) || 0;
  const grouped = String(absolute).replace(/\B(?=(\d{3})+$)/g, NBSP);
  const sign = amount < 0 ? '-' : '';

  return `${sign}${grouped}${NBSP}${CURRENCY_SUFFIX[locale]}`;
}
