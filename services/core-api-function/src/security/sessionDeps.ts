import type { AuthenticatedSession, Ctx, UserRecord } from '../http/context.ts';
// PLACEHOLDER: implemented by the security work stream.
export async function currentSession(_c: Ctx): Promise<AuthenticatedSession> { throw new Error('not implemented'); }
export async function currentUser(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export async function csrfProtectedUser(_c: Ctx): Promise<UserRecord> { throw new Error('not implemented'); }
export async function requireTrustedOrigin(_c: Ctx): Promise<void> { throw new Error('not implemented'); }
