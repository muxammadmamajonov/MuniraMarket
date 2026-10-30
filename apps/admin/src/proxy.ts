import { LOCALE_COOKIE, isLocale, negotiateLocale } from '@muniramarket/contracts';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js 16 renamed `middleware` to `proxy`. Requests whose path has no locale segment are
 * redirected to `/<locale>/...`, choosing the `locale` cookie first, then Accept-Language.
 *
 * TODO(admin-auth): this proxy only handles locale routing. It is NOT an authentication layer.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isLocale(pathname.split('/')[1])) return NextResponse.next();

  const locale = negotiateLocale({
    cookie: request.cookies.get(LOCALE_COOKIE)?.value,
    acceptLanguage: request.headers.get('accept-language'),
  });

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;

  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Accept-Language, Cookie');
  return response;
}

export const config = {
  // Skip Next internals, API routes and anything that looks like a file (has an extension).
  // robots.txt is a file, so it is served without a locale prefix.
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
