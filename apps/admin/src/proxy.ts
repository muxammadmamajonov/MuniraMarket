import { LOCALE_COOKIE, negotiateLocale } from '@muniramarket/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { localeFromPathname } from './i18n/switch-locale';
import { buildContentSecurityPolicy, generateNonce } from './lib/csp';

/**
 * Next.js 16 renamed `middleware` to `proxy`. It does two things:
 *
 * 1. Requests whose path has no locale segment are redirected to `/<locale>/...`, choosing the
 *    `locale` cookie first, then Accept-Language.
 * 2. Every page request gets a fresh CSP nonce (see `lib/csp.ts`; `frame-ancestors 'none'`). The
 *    policy is set on the response and also forwarded on the request headers, which is how Next
 *    learns the nonce and applies it to its own scripts during server rendering. This makes pages
 *    dynamic (no static prerendering), and they are sent `Cache-Control: private, no-store`.
 *
 * What this proxy is NOT: an authentication layer. It never looks at the session cookie and it
 * cannot, since the session lives in Core API's Redis. Access control is enforced in two places:
 *
 * - Core API (the security boundary): every `/api/v1/admin/**` request re-reads the user's role
 *   from the database and answers 401/403 unless the user is an operator or admin.
 * - The admin UI (`components/admin-shell.tsx`): renders order screens, and so requests order
 *   data, only for a signed-in operator/admin session. Customers see "access denied", visitors
 *   without a session see sign-in. This is a convenience, not a boundary: the HTML and JS of the
 *   screens contain no order data, and the same-origin proxy only forwards `auth/**` and
 *   `admin/**` (`lib/api/api-proxy.ts`).
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
    // The shell is the same for everyone, but it must not be kept by shared caches (the CSP nonce
    // is per request, and an admin page is never public).
    response.headers.set('Cache-Control', 'private, no-store');
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
  // robots.txt is a file, so it is served without a locale prefix.
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
