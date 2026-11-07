import type { NextConfig } from 'next';

// Unlike the public web app, the admin is never embedded (not even by Telegram Web), so framing
// is denied outright.
//
// The full Content-Security-Policy of HTML pages needs a per-request nonce, so `src/proxy.ts`
// builds it (`src/lib/csp.ts`) and it replaces the static policy below on pages. The static
// `frame-ancestors` policy stays as a floor for every response the proxy does not handle (the API
// proxy, Next assets, robots.txt). Pages get `Cache-Control: private, no-store` from the proxy; API
// responses are `no-store` through `src/lib/api/api-proxy.ts`.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Isolates the browsing context group from cross-origin openers. `same-origin-allow-popups`,
  // not `same-origin`: it is the value Telegram documents as compatible with its sign-in, and it
  // keeps links we open in a new window (e.g. Telegram, maps) working.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  // Defence in depth next to the `robots` metadata and robots.txt: keep the admin out of indexes.
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ['@muniramarket/ui', '@muniramarket/contracts'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
