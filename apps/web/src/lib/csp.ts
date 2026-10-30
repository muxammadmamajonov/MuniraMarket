/**
 * Content Security Policy for HTML pages, built per request in `src/proxy.ts`.
 *
 * Scripts are restricted to same-origin files plus the per-request nonce (Next applies it to its
 * own inline/bootstrap scripts and to `<Script>` tags) and `'strict-dynamic'`, so a script that a
 * trusted script loads (for example the Telegram widget) is allowed without a host allow-list.
 * `https://telegram.org` is listed for browsers that ignore `'strict-dynamic'`. There is no
 * `'unsafe-inline'` in `script-src`.
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
    'https://telegram.org',
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // Inline styles are allowed because a nonce cannot cover `style=""` attributes (React `style`
    // props, and the Telegram widget sets inline styles on its iframe). Style injection can't run
    // script, and scripts stay locked down above.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'"]],
    // The browser only talks to this origin: the API is reached through the same-origin proxy.
    ['connect-src', ["'self'"]],
    // Telegram Login Widget iframe.
    ['frame-src', ['https://oauth.telegram.org']],
    // Telegram Web embeds Mini Apps in an iframe; native clients use webviews (no framing).
    ['frame-ancestors', ["'self'", 'https://web.telegram.org', 'https://*.telegram.org']],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}
