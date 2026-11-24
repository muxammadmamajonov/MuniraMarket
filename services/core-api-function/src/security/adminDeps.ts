import { ApiError } from '../errors.ts';
import { RULES } from '../http/auth.ts';
import type { Ctx, UserRecord } from '../http/context.ts';
import { rateLimit } from './rateLimit.ts';
import { csrfProtectedUser, currentSession, currentUser } from './sessionDeps.ts';

/**
 * Back-office access control shared by every `/admin/**` route (port of
 * services/api/app/api/admin_deps.py). `operator` works orders; `admin` additionally manages the
 * catalog, users, CSV and reads the audit log. The role is re-read on every request and
 * checked BEFORE any entity is read. Only Telegram OIDC sessions minted on the admin origin are
 * back-office credentials (ADR 0014): a Mini App or storefront session never is.
 */

export interface AuditActor {
  userId: string;
  role: UserRecord['role'];
}

const STAFF_ROLES: ReadonlySet<UserRecord['role']> = new Set(['operator', 'admin']);
const ADMIN_ROLES: ReadonlySet<UserRecord['role']> = new Set(['admin']);

const staffRequired = (): ApiError => new ApiError(403, 'forbidden', 'Operator role required');
const adminRequired = (): ApiError => new ApiError(403, 'forbidden', 'Admin role required');

/** The router-level dependencies of every back-office route: ADMIN_IP limit, then the session. */
export async function backOfficeRouterDeps(c: Ctx): Promise<void> {
  await rateLimit(c, RULES.ADMIN_IP, 'ip');
  const auth = await currentSession(c);
  if (auth.session.auth_method !== 'telegram_oidc' || auth.session.entrance !== 'admin') {
    throw staffRequired();
  }
}

export async function requireStaff(c: Ctx): Promise<UserRecord> {
  const user = await currentUser(c);
  if (!STAFF_ROLES.has(user.role)) throw staffRequired();
  return user;
}

export async function requireStaffWriter(c: Ctx): Promise<UserRecord> {
  const user = await csrfProtectedUser(c);
  if (!STAFF_ROLES.has(user.role)) throw staffRequired();
  return user;
}

export async function requireAdmin(c: Ctx): Promise<UserRecord> {
  const user = await currentUser(c);
  if (!ADMIN_ROLES.has(user.role)) throw adminRequired();
  return user;
}

export async function requireAdminWriter(c: Ctx): Promise<UserRecord> {
  const user = await csrfProtectedUser(c);
  if (!ADMIN_ROLES.has(user.role)) throw adminRequired();
  return user;
}

export function auditActorOf(user: UserRecord): AuditActor {
  return { userId: user.id, role: user.role };
}
