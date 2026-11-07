import type { Ctx, UserRecord } from '../http/context.ts';
// PLACEHOLDER: implemented by the security work stream.
export interface AuditActor { userId: string; role: UserRecord['role'] }
export async function backOfficeRouterDeps(_c: Ctx): Promise<void> { throw new Error('not implemented'); }
export async function requireStaff(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export async function requireStaffWriter(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export async function requireAdmin(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export async function requireAdminWriter(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export function auditActorOf(user: UserRecord): AuditActor { return { userId: user.id, role: user.role }; }
