import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * Deliberately NOT set: `X-Frame-Options` and CSP `frame-ancestors`. Telegram Web opens Mini Apps
 * inside an iframe, so framing restrictions would break the app there. Revisit with an explicit
 * allow-list if Telegram documents stable embedding origins.
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
