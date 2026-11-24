import { z } from 'zod';
import { publicOrigin } from '../config.ts';
import {
  accountBlocked,
  ApiError,
  csrfFailed,
  type ErrorDetail,
  StoreUnavailableError,
  storeUnavailable,
} from '../errors.ts';
import { RULES } from '../http/auth.ts';
import { parseJson, readRawBody, validationError } from '../http/body.ts';
import {
  deps,
  queueCookie,
  type AuthMethod,
  type Ctx,
  type SessionEntrance,
} from '../http/context.ts';
import { upsertFromTelegram, userPublic, type UserPublic } from '../repositories/users.ts';
import {
  bindingCookieFrom,
  bindingCookieHeader,
  clearBindingCookie,
  clearSessionCookie,
  sessionTokenFrom,
  setSessionCookie,
} from '../security/cookies.ts';
import { checkToken, CSRF_HEADER, CsrfError } from '../security/csrf.ts';
import type { PendingLogin } from '../security/oidcState.ts';
import { rateLimit } from '../security/rateLimit.ts';
import { securityServices } from '../security/services.ts';
import type { IssuedSession } from '../security/session.ts';
import { currentSession, requireTrustedOrigin } from '../security/sessionDeps.ts';
import { constantTimeEqual, sha256Hex } from '../security/tokens.ts';
import { InvalidInitData, type VerifiedTelegramIdentity } from '../telegram/identity.ts';
import {
  authorizationUrl,
  CALLBACK_PATH,
  isPlausibleCode,
  newCodeVerifier,
  newSecretValue,
  OidcError,
  type OidcClient,
} from '../telegram/oidc.ts';
import type { Router } from './index.ts';

/**
 * Public auth routes (port of services/api/app/api/routes/auth.py, ADR 0004/0007/0014): Telegram
 * sign-in (Mini App initData and browser OIDC), session lookup and logout. Every response under
 * `/auth` is `Cache-Control: no-store` (app middleware). Dependencies run in FastAPI's order: the
 * JSON body is decoded first (FastAPI reads it before solving dependencies), then route-level
 * dependencies, then body/query validation.
 */

interface SessionResponse {
  user: UserPublic;
  csrf_token: string;
}

const invalidTelegramAuth = (message: string): ApiError =>
  new ApiError(401, 'invalid_telegram_auth', message);
const featureDisabled = (): ApiError =>
  new ApiError(404, 'feature_disabled', 'Telegram sign-in is disabled');

/** The gateway-written browser entrance; development/test without one fall back to storefront. */
export function requestEntrance(c: Ctx): SessionEntrance | null {
  const entrance = c.get('entrance');
  if (entrance === 'storefront' || entrance === 'admin') return entrance;
  const { appEnv } = deps(c).settings;
  return appEnv === 'development' || appEnv === 'test' ? 'storefront' : null;
}

function oidcClientOf(c: Ctx): OidcClient {
  const client = securityServices(deps(c)).oidc;
  if (client === null) throw featureDisabled();
  return client;
}

/** FastAPI decodes a non-empty JSON body before any dependency runs (422 on bad JSON). */
async function decodeBodyFirst(c: Ctx): Promise<void> {
  const raw = await readRawBody(c);
  if (raw.byteLength > 0) await parseJson(c, z.unknown());
}

async function signIn(
  c: Ctx,
  identity: VerifiedTelegramIdentity,
  authMethod: AuthMethod,
  entrance: SessionEntrance = 'storefront',
): Promise<SessionResponse> {
  const { db, logger } = deps(c);
  const { sessions } = securityServices(deps(c));
  const user = await upsertFromTelegram(db, {
    telegramUserId: identity.telegramUserId,
    firstName: identity.firstName,
    lastName: identity.lastName,
    username: identity.username,
    languageCode: identity.languageCode,
  });
  const previousToken = sessionTokenFrom(c);
  let issued: IssuedSession;
  try {
    if (user.is_blocked) {
      if (previousToken !== null) {
        await sessions.revoke(previousToken);
        clearSessionCookie(c);
      }
      throw accountBlocked();
    }
    issued = await sessions.create({
      userId: user.id,
      telegramUserId: user.telegram_user_id,
      authMethod,
      entrance,
      previousToken,
    });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      logger.error('Session store unavailable during sign-in; failing closed', {
        request_id: c.get('requestId'),
      });
      throw storeUnavailable();
    }
    throw error;
  }
  setSessionCookie(c, issued);
  return { user: userPublic(user), csrf_token: issued.data.csrf_token };
}

// --- Telegram OIDC (ADR 0014) --------------------------------------------------------------------

const RETURN_TO_MAX = 512;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const LOCALES = ['uz', 'ru'] as const;

/** A same-origin absolute path, or `/`. Never a scheme-relative or backslash path. */
export function safeReturnTo(value: string | null | undefined): string {
  if (value === null || value === undefined || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (Array.from(value).length > RETURN_TO_MAX || /[\x00-\x1f\\]/.test(value)) return '/';
  return value;
}

function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start += 1;
  while (end > start && value[end - 1] === '/') end -= 1;
  return value.slice(start, end);
}

/** The sign-in page of the locale `returnTo` points into, with a coarse reason. */
export function failureLocation(returnTo: string, reason: string): string {
  const first = stripSlashes(returnTo).split('/', 1)[0] ?? '';
  const locale = (LOCALES as readonly string[]).includes(first) ? first : LOCALES[0];
  return `/${locale}/auth/telegram?status=${reason}`;
}

function redirect(c: Ctx, location: string): Response {
  // The callback URL carries the authorization code: never leak it through Referer.
  return c.body(null, 303, { location, 'referrer-policy': 'no-referrer' });
}

class CallbackFailed extends Error {
  constructor(
    readonly location: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

async function completeOidcLogin(
  c: Ctx,
  oidc: OidcClient,
  login: PendingLogin,
  code: string | null,
): Promise<void> {
  const failed = failureLocation(login.returnTo, 'failed');
  const { settings, clock } = deps(c);
  const binding = bindingCookieFrom(c);
  if (binding === null || !constantTimeEqual(sha256Hex(binding), login.bindingHash)) {
    throw new CallbackFailed(failed, 'binding_mismatch');
  }
  const origin = publicOrigin(settings, login.entrance);
  if (requestEntrance(c) !== login.entrance || origin === null) {
    throw new CallbackFailed(failed, 'entrance_mismatch');
  }
  if (code === null || !isPlausibleCode(code)) {
    // Covers the user cancelling on Telegram (no code, an `error` parameter instead).
    throw new CallbackFailed(failureLocation(login.returnTo, 'cancelled'), 'no_code');
  }
  let identity: VerifiedTelegramIdentity;
  try {
    identity = await oidc.identityFor({
      code,
      redirectUri: `${origin}${CALLBACK_PATH}`,
      codeVerifier: login.codeVerifier,
      nonce: login.nonce,
      now: clock(),
    });
  } catch (error) {
    if (error instanceof OidcError) throw new CallbackFailed(failed, error.reason);
    throw error;
  }
  try {
    await signIn(c, identity, 'telegram_oidc', login.entrance);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'account_blocked') {
      throw new CallbackFailed(failureLocation(login.returnTo, 'blocked'), 'account_blocked');
    }
    if (error instanceof ApiError && error.status === 503) {
      throw new CallbackFailed(failureLocation(login.returnTo, 'unavailable'), 'store_unavailable');
    }
    throw error;
  }
}

/** Query string values like FastAPI (last occurrence wins). */
function queryValue(c: Ctx, name: string): string | null {
  const values = new URL(c.req.url).searchParams.getAll(name);
  return values.length === 0 ? null : (values[values.length - 1] ?? null);
}

const InitDataRequest = z.strictObject({ init_data: z.string().min(1).max(4096) });
const OidcStartRequest = z.strictObject({ return_to: z.string().max(512).nullish() });

export function register(router: Router): void {
  /** Which browser sign-in methods this origin may offer. */
  router.get('/auth/config', (c) => {
    const enabled = securityServices(deps(c)).oidc !== null && requestEntrance(c) !== null;
    return c.json({ telegram_oidc: { enabled } });
  });

  /** Verify Telegram Mini App `initData`, upsert the user and start a cookie session. */
  router.post('/auth/telegram/init-data', async (c) => {
    await decodeBodyFirst(c);
    await rateLimit(c, RULES.AUTH_LOGIN, 'ip');
    await requireTrustedOrigin(c);
    const payload = await parseJson(c, InitDataRequest);
    let identity: VerifiedTelegramIdentity;
    try {
      identity = securityServices(deps(c)).identityVerifier.verify(payload.init_data);
    } catch (error) {
      if (!(error instanceof InvalidInitData)) throw error;
      deps(c).logger.info('Rejected Telegram init data', { reason: error.reason });
      throw invalidTelegramAuth('Invalid Telegram init data');
    }
    return c.json(await signIn(c, identity, 'telegram_init_data'));
  });

  /** Begin a Telegram sign-in; sets a short-lived binding cookie for the callback. */
  router.post('/auth/telegram/oidc/start', async (c) => {
    await decodeBodyFirst(c);
    // Feature flag first: a disabled endpoint answers 404 before anything else happens.
    const oidc = oidcClientOf(c);
    await rateLimit(c, RULES.AUTH_LOGIN, 'ip');
    await requireTrustedOrigin(c);
    const payload = await parseJson(c, OidcStartRequest);
    const entrance = requestEntrance(c);
    const { settings, clock, logger } = deps(c);
    const origin = entrance === null ? null : publicOrigin(settings, entrance);
    if (entrance === null || origin === null) throw featureDisabled();
    const state = newSecretValue();
    const binding = newSecretValue();
    const nonce = newSecretValue();
    const verifier = newCodeVerifier();
    try {
      await securityServices(deps(c)).oidcStates.put(
        sha256Hex(state),
        {
          bindingHash: sha256Hex(binding),
          entrance,
          codeVerifier: verifier,
          nonce,
          returnTo: safeReturnTo(payload.return_to),
          createdAt: Math.trunc(clock()),
        },
        oidc.stateTtlSeconds,
      );
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) throw error;
      logger.error('OIDC state store unavailable; failing closed', {
        request_id: c.get('requestId'),
      });
      throw storeUnavailable();
    }
    queueCookie(c, bindingCookieHeader(c, binding, oidc.stateTtlSeconds));
    return c.json({
      authorization_url: authorizationUrl(oidc.endpoints, {
        clientId: oidc.clientId,
        redirectUri: `${origin}${CALLBACK_PATH}`,
        state,
        nonce,
        verifier,
      }),
    });
  });

  /** Telegram redirects here. Always answers `303` to a same-origin path. */
  router.get('/auth/telegram/oidc/callback', async (c) => {
    await rateLimit(c, RULES.AUTH_LOGIN, 'ip');
    const oidc = oidcClientOf(c);
    const code = queryValue(c, 'code');
    const state = queryValue(c, 'state');
    const details: ErrorDetail[] = [];
    if (code !== null && Array.from(code).length > 1024) {
      details.push({ loc: ['query', 'code'], msg: 'String should have at most 1024 characters' });
    }
    if (state !== null && Array.from(state).length > 64) {
      details.push({ loc: ['query', 'state'], msg: 'String should have at most 64 characters' });
    }
    if (details.length > 0) throw validationError(details);

    const { logger } = deps(c);
    clearBindingCookie(c);
    if (state === null || !STATE_RE.test(state)) {
      logger.info('Rejected Telegram OIDC callback', {
        reason: 'state_malformed',
        request_id: c.get('requestId'),
      });
      return redirect(c, failureLocation('/', 'failed'));
    }
    let login: PendingLogin | null;
    try {
      login = await securityServices(deps(c)).oidcStates.take(sha256Hex(state));
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) throw error;
      logger.error('OIDC state store unavailable; failing closed', {
        request_id: c.get('requestId'),
      });
      return redirect(c, failureLocation('/', 'unavailable'));
    }
    if (login === null) {
      logger.info('Rejected Telegram OIDC callback', {
        reason: 'state_unknown',
        request_id: c.get('requestId'),
      });
      return redirect(c, failureLocation('/', 'failed'));
    }
    try {
      await completeOidcLogin(c, oidc, login, code);
    } catch (error) {
      if (!(error instanceof CallbackFailed)) throw error;
      logger.info('Rejected Telegram OIDC callback', {
        reason: error.reason,
        request_id: c.get('requestId'),
      });
      return redirect(c, error.location);
    }
    return redirect(c, login.returnTo);
  });

  /** The signed-in user and the CSRF token (e.g. after a page reload). */
  router.get('/auth/session', async (c) => {
    await rateLimit(c, RULES.AUTH_SESSION, 'ip');
    const auth = await currentSession(c);
    return c.json({ user: userPublic(auth.user), csrf_token: auth.session.csrf_token });
  });

  /**
   * Delete the session (if any) and expire the cookie. Idempotent. When a live session is
   * presented, `X-CSRF-Token` must match it, so a cross-site request cannot sign the user out.
   */
  router.post('/auth/logout', async (c) => {
    await rateLimit(c, RULES.AUTH_SESSION, 'ip');
    await requireTrustedOrigin(c);
    const token = sessionTokenFrom(c);
    const { logger } = deps(c);
    if (token !== null) {
      const { sessions } = securityServices(deps(c));
      try {
        const session = await sessions.peek(token);
        if (session !== null) {
          try {
            checkToken(session.csrf_token, c.req.header(CSRF_HEADER));
          } catch (error) {
            if (!(error instanceof CsrfError)) throw error;
            logger.info('CSRF check failed on logout', { reason: error.reason });
            throw csrfFailed();
          }
          await sessions.revoke(token);
        }
      } catch (error) {
        if (!(error instanceof StoreUnavailableError)) throw error;
        logger.error('Session store unavailable during logout; failing closed');
        throw storeUnavailable();
      }
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });
}
