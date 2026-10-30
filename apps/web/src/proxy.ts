import { LOCALE_COOKIE, negotiateLocale } from '@muniramarket/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, generateNonce } from './lib/csp';
import { localeFromPathname } from './i18n/switch-locale';

/**
 * Next.js 16 renamed `middleware` to `proxy`. It does two things:
 *
 * 1. Requests whose path has no locale segment are redirected to `/<locale>/...`, choosing the
 *    `locale` cookie first, then Accept-Language.
 * 2. Every page request gets a fresh CSP nonce. The policy is set on the response and also
 *    forwarded on the request headers, which is how Next learns the nonce and applies it to its
 *    own scripts during server rendering. This makes pages dynamic (no static prerendering).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (localeFromPathname(pathname) !== null) {
    const csp = buildContentSecurityPolicy({
      nonce: generateNonce(),
      isDevelopment: process.env.NODE_ENV === 'development',
    });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('Content-Security-Policy', csp);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  }

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
