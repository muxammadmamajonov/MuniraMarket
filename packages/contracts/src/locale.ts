/** Languages the storefront and admin are translated into. */
export const SUPPORTED_LOCALES = ['uz', 'ru'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'uz';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Name of the cookie that persists the visitor's chosen language (not localStorage). */
export const LOCALE_COOKIE = 'locale';

export interface NegotiateLocaleInput {
  /** Value of the `locale` cookie, if any. */
  cookie?: string | null | undefined;
  /** Raw `Accept-Language` header, if any. */
  acceptLanguage?: string | null | undefined;
}

/**
 * Picks the locale for a visitor: a valid `locale` cookie wins, then the best supported
 * `Accept-Language` entry (highest q-value, primary subtag only, so `ru-RU` -> `ru`), then
 * {@link DEFAULT_LOCALE}. Pure and runtime-agnostic, so it is safe in proxy/middleware.
 */
export function negotiateLocale(input: NegotiateLocaleInput): Locale {
  if (isLocale(input.cookie)) return input.cookie;

  const header = input.acceptLanguage;
  if (!header) return DEFAULT_LOCALE;

  const candidates: { locale: Locale; q: number; order: number }[] = [];
  header.split(',').forEach((part, order) => {
    const [tag = '', ...params] = part.trim().split(';');
    const primary = tag.trim().toLowerCase().split('-')[0] ?? '';
    if (!isLocale(primary)) return;

    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim().toLowerCase() === 'q') {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (q > 0) candidates.push({ locale: primary, q, order });
  });

  candidates.sort((a, b) => b.q - a.q || a.order - b.order);
  return candidates[0]?.locale ?? DEFAULT_LOCALE;
}
