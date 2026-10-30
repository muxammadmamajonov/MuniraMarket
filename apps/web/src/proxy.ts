import { LOCALE_COOKIE, negotiateLocale } from '@muniramarket/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { localeFromPathname } from './i18n/switch-locale';

/**
 * Next.js 16 renamed `middleware` to `proxy`. Requests whose path has no locale segment are
 * redirected to `/<locale>/...`, choosing the `locale` cookie first, then Accept-Language.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (localeFromPathname(pathname) !== null) return NextResponse.next();

  const locale = negotiateLocale({
    cookie: request.cookies.get(LOCALE_COOKIE)?.value,
    acceptLanguage: request.headers.get('accept-language'),
  });

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;

  const response = NextResponse.redirect(url);
  // The target depends on request headers, so it must never be shared between visitors.
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Accept-Language, Cookie');
  return response;
}

export const config = {
  // Skip Next internals, API routes and anything that looks like a file (has an extension).
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
