import { apiProxy } from '@/lib/api/api-proxy';

/**
 * Same-origin proxy to the Core API: browsers call `/api/v1/*` on the admin origin, so the session
 * cookie is first-party and CSP can say `connect-src 'self'`. Only `auth/**` and `admin/**` are
 * forwarded; see `lib/api/api-proxy.ts`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiProxy;
export const POST = apiProxy;
export const PUT = apiProxy;
export const PATCH = apiProxy;
export const DELETE = apiProxy;
