import type { UserPublic, UserRole } from '@muniramarket/contracts';

/** Roles that may use the back office. Core API enforces the same set on every request. */
export const STAFF_ROLES: readonly UserRole[] = ['operator', 'admin'];

/** UI convenience only: Core API re-checks the role in the database on every `/admin/**` call. */
export function isStaff(user: Pick<UserPublic, 'role'> | null): boolean {
  return user !== null && STAFF_ROLES.includes(user.role);
}

/** Catalog, delivery, users and audit are admin-only; operators work orders and the dashboard. */
export function isAdmin(user: Pick<UserPublic, 'role'> | null): boolean {
  return user !== null && user.role === 'admin';
}
