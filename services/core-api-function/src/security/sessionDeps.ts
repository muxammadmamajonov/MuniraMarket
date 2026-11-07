import {
  accountBlocked,
  csrfFailed,
  sessionRequired,
  StoreUnavailableError,
  storeUnavailable,
} from '../errors.ts';
import { deps, type AuthenticatedSession, type Ctx, type UserRecord } from '../http/context.ts';
import { getUserById } from '../repositories/users.ts';
import { clearSessionCookie, sessionTokenFrom, setSessionCookie } from './cookies.ts';
import { checkOrigin, checkToken, CSRF_HEADER, CsrfError, isUnsafeMethod } from './csrf.ts';
import { securityServices } from './services.ts';
import { SessionGoneError, type IssuedSession } from './session.ts';

/**
 * Browser-session dependencies (port of services/api/app/api/auth_deps.py). See the contract in
 * src/http/auth.ts. The user is re-read from the database on every request; a blocked user's
 * session is revoked and the cookie cleared; a due rotation queues a new cookie that is delivered
 * whatever the route then does.
 */

async function loadSession(c: Ctx): Promise<AuthenticatedSession> {
  const token = sessionTokenFrom(c);
  if (token === null) throw sessionRequired();
  const { db, logger } = deps(c);
  const { sessions } = securityServices(deps(c));
  try {
    const loaded = await sessions.load(token);
    if (loaded === null) {
      // No expiring Set-Cookie: this request may have raced a rotation whose fresh cookie the
      // browser already stored. Only logout and explicit revocation clear the cookie.
      throw sessionRequired();
    }
    const user = await getUserById(db, loaded.data.user_id);
    if (user === null || user.telegram_user_id !== loaded.data.telegram_user_id) {
      await sessions.revoke(token);
      clearSessionCookie(c);
      throw sessionRequired();
    }
    if (user.is_blocked) {
      // Blocking takes effect on the very next request.
      await sessions.revoke(token);
      clearSessionCookie(c);
      throw accountBlocked();
    }
    let rotated: IssuedSession | null;
    try {
      rotated = await sessions.rotateIfDue(loaded);
    } catch (error) {
      if (error instanceof SessionGoneError) throw sessionRequired();
      throw error;
    }
    if (rotated === null) return { user, session: loaded.data };
    setSessionCookie(c, rotated);
    return { user, session: rotated.data };
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      logger.error('Session store unavailable; failing closed');
      throw storeUnavailable();
    }
    throw error;
  }
}

/** The signed-in, non-blocked user's session. Memoised per request (`c.var.authPromise`). */
export function currentSession(c: Ctx): Promise<AuthenticatedSession> {
  const existing = c.get('authPromise');
  if (existing !== undefined) return existing;
  const promise = loadSession(c);
  // The rejection is observed by every caller; this only keeps it from being "unhandled".
  promise.catch(() => undefined);
  c.set('authPromise', promise);
  return promise;
}

export async function currentUser(c: Ctx): Promise<UserRecord> {
  return (await currentSession(c)).user;
}

function enforceOrigin(c: Ctx): void {
  const { settings } = deps(c);
  checkOrigin(
    { origin: c.req.header('origin'), referer: c.req.header('referer') },
    { trustedOrigins: settings.csrfTrustedOrigins, appEnv: settings.appEnv },
  );
}

/** Origin check only, for unsafe requests that have no session yet (login, logout). */
export async function requireTrustedOrigin(c: Ctx): Promise<void> {
  if (!isUnsafeMethod(c.req.method)) return;
  try {
    enforceOrigin(c);
  } catch (error) {
    if (!(error instanceof CsrfError)) throw error;
    deps(c).logger.info('CSRF origin check failed', { reason: error.reason });
    throw csrfFailed();
  }
}

/** `currentUser`, then (unsafe methods) trusted Origin and `X-CSRF-Token` == session token. */
export async function csrfProtectedUser(c: Ctx): Promise<UserRecord> {
  const auth = await currentSession(c);
  if (isUnsafeMethod(c.req.method)) {
    try {
      enforceOrigin(c);
      checkToken(auth.session.csrf_token, c.req.header(CSRF_HEADER));
    } catch (error) {
      if (!(error instanceof CsrfError)) throw error;
      deps(c).logger.info('CSRF check failed', { reason: error.reason });
      throw csrfFailed();
    }
  }
  return auth.user;
}
