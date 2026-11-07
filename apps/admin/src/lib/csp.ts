/**
 * Content Security Policy for HTML pages, built per request in `src/proxy.ts`.
 *
 * Scripts are restricted to same-origin files plus the per-request nonce (Next applies it to its
 * own inline/bootstrap scripts and to scripts it injects) and `'strict-dynamic'`. Nothing is
 * loaded from Telegram: "Sign in with Telegram" is an OIDC redirect run by the Core API (a
 * top-level `location.assign`, which `form-action` does not govern), so there is no Telegram host
 * in `script-src` and nothing may be framed (`frame-src 'none'`). There is no `'unsafe-inline'` in
 * `script-src`.
 *
 * Unlike the storefront, the admin is never embedded (not even by Telegram Web), so
 * `frame-ancestors` is `'none'`; `next.config.ts` also sends `X-Frame-Options: DENY`.
 */

export interface CspOptions {
  nonce: string;
  /** Adds `'unsafe-eval'` to `script-src`; React's dev tooling needs it. Never in production. */
  isDevelopment?: boolean;
}

/** 16 random bytes, base64. Fresh for every request. Works in any runtime with Web Crypto. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The nonce is interpolated into a response header, so refuse anything that is not base64.
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function buildContentSecurityPolicy({ nonce, isDevelopment = false }: CspOptions): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('CSP nonce must be a base64 string.');

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // Inline styles are allowed because a nonce cannot cover `style=""` attributes (React `style`
    // props). Style injection can't run script, and scripts stay locked down above.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    // The browser only talks to this origin: the API is reached through the same-origin proxy.
    ['connect-src', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}
