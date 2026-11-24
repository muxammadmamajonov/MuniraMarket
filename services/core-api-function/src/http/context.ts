import type { Context } from 'hono';
import type { Settings } from '../config.ts';
import type { Database } from '../db.ts';
import type { Logger } from '../logging.ts';

/**
 * Shared request context: what every route and dependency reads. Built once per isolate in
 * src/index.ts (or per test in test/helpers) and attached to each request by `createApp`.
 */

export type Language = 'uz' | 'ru';
export type UserRole = 'customer' | 'operator' | 'admin';
export type AuthMethod = 'telegram_init_data' | 'telegram_oidc';
/** Gateway entrance the request came through (`X-MM-Entrance`, written only by the gateway). */
export type Entrance = 'public' | 'storefront' | 'admin' | 'scheduler';
/** Which browser origin minted a session. */
export type SessionEntrance = 'storefront' | 'admin';

export interface UserRecord {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language: Language;
  role: UserRole;
  is_blocked: boolean;
  /** An explicit language choice was made (bot onboarding or the shop profile). */
  language_confirmed: boolean;
  /** The account phone is verified; the number itself never leaves the API. */
  phone_verified: boolean;
  /** The account number (verified or typed); read only to build `phone_hint`, never serialised. */
  phone?: string | null;
  /** `YYYY-MM-DD`, or null. */
  birth_date: string | null;
}

export interface SessionData {
  user_id: string;
  telegram_user_id: number;
  csrf_token: string;
  auth_method: AuthMethod;
  created_at: number;
  last_rotated_at: number;
  entrance: SessionEntrance;
}

export interface AuthenticatedSession {
  user: UserRecord;
  session: SessionData;
}

/** Signed service request (ADR 0003): the acting Telegram user, if any. */
export interface ServiceContext {
  keyId: string;
  actorTelegramUserId: number | null;
}

/** Epoch seconds. Injectable so tests control expiry, rotation and rate-limit windows. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now() / 1000;

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Security services implemented under src/security and src/telegram. Typed loosely here (by
 * name) so that the route modules and the security modules only meet through these contracts.
 */
export interface Deps {
  settings: Settings;
  db: Database;
  clock: Clock;
  logger: Logger;
  /** Outbound HTTP (Telegram OIDC token exchange, JWKS, Bot API). */
  fetch: FetchFn;
}

export type AppBindings = {
  Variables: {
    deps: Deps;
    requestId: string;
    entrance: Entrance;
    /** The visitor IP the gateway wrote into `X-Forwarded-For` (single address) or 'unknown'. */
    clientIp: string;
    /** `Set-Cookie` headers queued per cookie name; added to whatever response leaves the app. */
    queuedCookies: Map<string, string>;
    /** Memoised session lookup for this request (see src/http/auth.ts). */
    authPromise?: Promise<AuthenticatedSession>;
    /** Route template for the access log (`/api/v1/orders/:order_id`). */
    routeTemplate?: string;
    /** Raw request body, read once (signature verification needs the exact bytes). */
    rawBody?: Uint8Array;
  };
};

export type Ctx = Context<AppBindings>;

export function deps(c: Ctx): Deps {
  return c.get('deps');
}

/** `Set-Cookie: value` on the response, whatever its status (errors included). */
export function queueCookie(c: Ctx, headerValue: string): void {
  const name = headerValue.split('=', 1)[0] ?? '';
  c.get('queuedCookies').set(name, headerValue);
}
