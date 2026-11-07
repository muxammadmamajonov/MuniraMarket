/**
 * Request dependencies shared by every route (port of services/api/app/api/auth_deps.py,
 * admin_deps.py and deps.py). CONTRACT: route modules call these in the SAME ORDER FastAPI
 * resolves the reference route's dependencies, so status codes match (e.g. an IP limit before
 * the session check, the role check before any entity is read).
 *
 * - `currentSession(c)` / `currentUser(c)`: signed-in, non-blocked user. 401 `session_required`
 *   without a valid session cookie, 403 `account_blocked` (session revoked, cookie cleared).
 *   Due rotation queues a new `Set-Cookie` (delivered even if the route then fails). Memoised per
 *   request.
 * - `csrfProtectedUser(c)`: same, plus trusted Origin and `X-CSRF-Token` == session token on
 *   unsafe methods (403 `csrf_failed`).
 * - `requireTrustedOrigin(c)`: Origin check only (login/logout: no session yet).
 * - `rateLimit(c, rule, 'ip' | 'user')`: 429 `rate_limited` with `Retry-After` and no-store.
 * - Back office: `backOfficeRouterDeps(c)` (ADMIN_IP limit, then admin-origin OIDC session),
 *   then `requireStaff`/`requireStaffWriter`/`requireAdmin`/`requireAdminWriter`.
 * - Signed service requests (ADR 0003): `requireServiceRequest(c)`, `requireActor(c)`.
 * - Security-store failures are 503 `service_unavailable` (fail closed).
 */
import type { AuthenticatedSession, Ctx, ServiceContext, UserRecord } from './context.ts';

export interface RateLimitRule {
  scope: string;
  limit: number;
  windowSeconds: number;
}

const rule = (scope: string, limit: number, windowSeconds: number): RateLimitRule => ({
  scope,
  limit,
  windowSeconds,
});

/** Same values as services/api/app/security/rate_limit.py. */
export const RULES = {
  AUTH_LOGIN: rule('auth_login', 10, 60), // per IP
  AUTH_SESSION: rule('auth_session', 60, 60), // per IP
  CART_READ: rule('cart_read', 120, 60), // per user
  CART_WRITE: rule('cart_write', 60, 60), // per user
  CART_IP: rule('cart_ip', 300, 60), // per IP, every /cart route
  CATALOG_IP: rule('catalog_ip', 300, 60), // per IP, public catalog reads
  ORDERS_IP: rule('orders_ip', 300, 60), // per IP, every /checkout and /orders route
  CHECKOUT_QUOTE: rule('checkout_quote', 60, 60), // per user
  ORDER_CREATE: rule('order_create', 10, 60), // per user
  ORDER_READ: rule('order_read', 120, 60), // per user
  ORDER_CANCEL: rule('order_cancel', 20, 60), // per user
  ADMIN_IP: rule('admin_ip', 600, 60), // per IP
  ADMIN_READ: rule('admin_read', 300, 60), // per user
  ADMIN_WRITE: rule('admin_write', 120, 60), // per user
  ADMIN_CSV_IMPORT: rule('admin_csv_import', 10, 60), // per user
  ADMIN_CSV_EXPORT: rule('admin_csv_export', 20, 60), // per user
} as const;

export { currentSession, currentUser, csrfProtectedUser, requireTrustedOrigin } from '../security/sessionDeps.ts';
export { rateLimit } from '../security/rateLimit.ts';
export {
  backOfficeRouterDeps,
  requireStaff,
  requireStaffWriter,
  requireAdmin,
  requireAdminWriter,
  auditActorOf,
} from '../security/adminDeps.ts';
export { requireServiceRequest, requireActor } from '../security/serviceAuth.ts';

export type { AuthenticatedSession, Ctx, ServiceContext, UserRecord };
