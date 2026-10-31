import { LOCALE_COOKIE, isLocale, type Locale } from '@muniramarket/contracts';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Returns `pathname` with its leading locale segment replaced by `target`
 * (`/uz/cart` -> `/ru/cart`). A path without a locale segment gets one prefixed.
 */
export function switchLocalePath(pathname: string, target: Locale): string {
  const segments = pathname.split('/');
  // segments[0] is '' for an absolute path; the locale, if any, is segments[1].
  if (isLocale(segments[1])) {
    segments[1] = target;
    return segments.join('/');
  }
  const rest = pathname === '/' ? '' : pathname;
  return `/${target}${rest}`;
}

/** The locale in a pathname's first segment, or `null`. */
export function localeFromPathname(pathname: string): Locale | null {
  const first = pathname.split('/')[1];
  return isLocale(first) ? first : null;
}

/**
 * `Set-Cookie`-style string persisting the chosen locale. A cookie (not localStorage) so the
 * proxy can read it server-side on the next visit to `/`.
 */
export function serializeLocaleCookie(locale: Locale, secure: boolean): string {
  const parts = [
    `${LOCALE_COOKIE}=${locale}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function persistLocale(locale: Locale): void {
  document.cookie = serializeLocaleCookie(locale, window.location.protocol === 'https:');
}
