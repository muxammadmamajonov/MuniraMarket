import type { NextConfig } from 'next';

/**
 * Security headers that do not depend on the request.
 *
 * The Content-Security-Policy is NOT set here: it needs a per-request nonce, so `src/proxy.ts`
 * builds it (see `src/lib/csp.ts`). That policy also owns framing: `frame-ancestors` allows only
 * this origin and Telegram (`https://web.telegram.org`, `https://*.telegram.org`), because
 * Telegram Web embeds Mini Apps in an iframe. `X-Frame-Options` is deliberately not set; it cannot
 * express that allow-list and would break the Mini App in Telegram Web.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(), geolocation=(self)' },
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
