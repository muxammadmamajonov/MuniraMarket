import type { Deps } from '../http/context.ts';
import { buildIdentityVerifier, type TelegramIdentityVerifier } from '../telegram/identity.ts';
import { buildOidcClient, type OidcClient } from '../telegram/oidc.ts';
import { PostgresOidcStateStore } from './oidcState.ts';
import { PostgresSessionStore, SessionManager } from './session.ts';

/**
 * Security services built lazily, once per `Deps` (one per isolate in production, one per test
 * app), so the stores read `deps.clock` and tests can inject a clock or a fake `fetch`. Every
 * store is PostgreSQL-backed (ADR 0013); nothing is kept in memory except the OIDC JWKS cache.
 */
export interface SecurityServices {
  sessionStore: PostgresSessionStore;
  sessions: SessionManager;
  oidcStates: PostgresOidcStateStore;
  identityVerifier: TelegramIdentityVerifier;
  /** `null` when Telegram OIDC sign-in is disabled or not configured. */
  oidc: OidcClient | null;
}

const cache = new WeakMap<Deps, SecurityServices>();

export function securityServices(deps: Deps): SecurityServices {
  const existing = cache.get(deps);
  if (existing !== undefined) return existing;
  const { settings, db, logger } = deps;
  const clock = () => deps.clock();
  const sessionStore = new PostgresSessionStore(db, clock, logger);
  const services: SecurityServices = {
    sessionStore,
    sessions: new SessionManager(sessionStore, clock, {
      idleTtlSeconds: settings.sessionIdleTtlSeconds,
      absoluteTtlSeconds: settings.sessionAbsoluteTtlSeconds,
      rotateAfterSeconds: settings.sessionRotateAfterSeconds,
      rotationGraceSeconds: settings.sessionRotationGraceSeconds,
    }),
    oidcStates: new PostgresOidcStateStore(db, clock),
    identityVerifier: buildIdentityVerifier(settings, clock),
    oidc: buildOidcClient(settings, clock, (input, init) => deps.fetch(input, init)),
  };
  cache.set(deps, services);
  return services;
}
