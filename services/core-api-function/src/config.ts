/**
 * Environment-driven settings, validated eagerly so a bad deployment fails at startup (port of
 * services/api/app/core/config.py). Validation messages never echo a value: several are secrets.
 *
 * Differences from the container era, by design:
 * - `DATABASE_URL` is injected by Neon at runtime (pooled, TLS). It is never set by hand, never
 *   written to `neon.ts` or an example file. `DATABASE_URL_UNPOOLED` is for Alembic only.
 * - No CORS and no `FORWARDED_ALLOW_IPS`: browsers never call the Function; the only ingress is
 *   the Cloudflare gateway, authenticated by `CORE_API_FUNCTION_SECRET` (src/http/gatewaySecret.ts),
 *   which also writes `X-Forwarded-For` itself.
 * - The pool size is fixed at 5 per isolate (src/db.ts).
 */

export type AppEnv = 'development' | 'test' | 'staging' | 'production';
export type TelegramEnvironment = 'production' | 'test';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export const DEPLOYED_ENVS: readonly AppEnv[] = ['staging', 'production'];
export const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org';
export const MIN_SECRET_BYTES = 32;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_ROTATION_GRACE_SECONDS = 300;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RELEASE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Settings {
  appEnv: AppEnv;
  databaseUrl: string;
  /** Shared secret the gateway sends on every request (`X-MM-Gateway-Secret`). */
  functionSecret: string;
  serviceAuthKeys: ReadonlyMap<string, string>;
  telegramBotId: number;
  telegramInitDataMaxAgeSeconds: number;
  telegramEnvironment: TelegramEnvironment;
  /** Optional; when set, initData is verified with HMAC and outbox drains can send messages. */
  telegramBotToken: string | null;
  sessionCookieSecure: boolean;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  sessionRotateAfterSeconds: number;
  sessionRotationGraceSeconds: number;
  csrfTrustedOrigins: readonly string[];
  telegramOidcEnabled: boolean;
  telegramOidcClientId: number | null;
  telegramOidcClientSecret: string | null;
  telegramOidcIssuer: string;
  webPublicOrigin: string | null;
  adminPublicOrigin: string | null;
  telegramOidcStateTtlSeconds: number;
  logLevel: LogLevel;
  appRelease: string | null;
  dbStatementTimeoutMs: number;
  dbIdleInTransactionTimeoutMs: number;
  /** `SET LOCAL ROLE` target for every transaction (least privilege, src/db.ts). */
  dbRuntimeRole: string | null;
}

export function sessionCookieName(settings: Pick<Settings, 'sessionCookieSecure'>): string {
  // The __Host- prefix makes browsers insist on Secure, Path=/ and no Domain attribute.
  return settings.sessionCookieSecure ? '__Host-mm_session' : 'mm_session';
}

export function bindingCookieName(secure: boolean): string {
  return secure ? '__Host-mm_oidc' : 'mm_oidc';
}

export function docsEnabled(settings: Pick<Settings, 'appEnv'>): boolean {
  return settings.appEnv === 'development' || settings.appEnv === 'test';
}

export function publicOrigin(settings: Settings, entrance: string): string | null {
  if (entrance === 'admin') return settings.adminPublicOrigin;
  if (entrance === 'storefront') return settings.webPublicOrigin;
  return null;
}

/** `scheme://host[:port]` (lower-case, default port dropped) or `null`. Same rules as Python. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (!(scheme in DEFAULT_PORTS) || !url.hostname || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const port = url.port === '' ? DEFAULT_PORTS[scheme] : Number(url.port);
  const base = `${scheme}//${host}`;
  return port === DEFAULT_PORTS[scheme] ? base : `${base}:${port}`;
}

function isBareOrigin(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Parse `key_id:secret[,key_id:secret]` (ADR 0003). Error messages never echo secrets. */
export function parseServiceAuthKeys(raw: string): Map<string, string> {
  const keys = new Map<string, string>();
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new ConfigError('SERVICE_AUTH_KEYS must contain at least one key_id:secret pair');
  }
  entries.forEach((entry, index) => {
    const position = index + 1;
    const separator = entry.indexOf(':');
    if (separator < 0) {
      throw new ConfigError(`SERVICE_AUTH_KEYS entry ${position} must look like key_id:secret`);
    }
    const keyId = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (!KEY_ID_RE.test(keyId)) {
      throw new ConfigError(`SERVICE_AUTH_KEYS entry ${position} has an invalid key id`);
    }
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new ConfigError(
        `SERVICE_AUTH_KEYS entry ${position} secret must be at least ${MIN_SECRET_BYTES} bytes`,
      );
    }
    if (keys.has(keyId)) {
      throw new ConfigError(`SERVICE_AUTH_KEYS contains a duplicate key id (entry ${position})`);
    }
    keys.set(keyId, secret);
  });
  return keys;
}

type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = text(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  return Number(raw);
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = text(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean`);
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback?: T): T {
  const raw = text(env, name);
  if (raw === undefined) {
    if (fallback === undefined) throw new ConfigError(`${name} is required`);
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

function commaList(env: Env, name: string): string[] {
  return (text(env, name) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function range(name: string, value: number, min: number, max: number): number {
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function publicOriginSetting(env: Env, name: string): string | null {
  const raw = text(env, name);
  if (raw === undefined) return null;
  const origin = normalizeOrigin(raw);
  if (origin === null || !isBareOrigin(raw)) {
    throw new ConfigError('WEB_PUBLIC_ORIGIN/ADMIN_PUBLIC_ORIGIN must look like scheme://host');
  }
  return origin;
}

/** Build and validate settings from `env` (normally `process.env`). Throws `ConfigError`. */
export function loadSettings(env: Env): Settings {
  const appEnv = oneOf<AppEnv>(env, 'APP_ENV', ['development', 'test', 'staging', 'production']);
  const deployed = DEPLOYED_ENVS.includes(appEnv);

  const databaseUrl = required(env, 'DATABASE_URL');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('DATABASE_URL must be a postgres:// URL');
  }
  if (deployed) {
    const sslmode = new URL(databaseUrl).searchParams.get('sslmode');
    if (sslmode !== 'require' && sslmode !== 'verify-full') {
      throw new ConfigError('DATABASE_URL must use TLS (sslmode=require) outside development');
    }
  }

  const functionSecret = required(env, 'CORE_API_FUNCTION_SECRET');
  if (Buffer.byteLength(functionSecret, 'utf8') < MIN_SECRET_BYTES) {
    throw new ConfigError(`CORE_API_FUNCTION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }

  const serviceAuthKeys = parseServiceAuthKeys(required(env, 'SERVICE_AUTH_KEYS'));

  const telegramBotId = int(env, 'TELEGRAM_BOT_ID', 0);
  if (deployed && telegramBotId <= 0) {
    throw new ConfigError('TELEGRAM_BOT_ID must be a positive integer outside development');
  }
  const telegramEnvironment = oneOf<TelegramEnvironment>(
    env,
    'TELEGRAM_ENVIRONMENT',
    ['production', 'test'],
    'production',
  );
  if (appEnv === 'production' && telegramEnvironment === 'test') {
    throw new ConfigError('TELEGRAM_ENVIRONMENT=test is not allowed when APP_ENV=production');
  }
  const telegramInitDataMaxAgeSeconds = int(env, 'TELEGRAM_INIT_DATA_MAX_AGE_SECONDS', 3600);
  if (telegramInitDataMaxAgeSeconds <= 0) {
    throw new ConfigError('TELEGRAM_INIT_DATA_MAX_AGE_SECONDS must be positive');
  }

  const sessionCookieSecure = bool(env, 'SESSION_COOKIE_SECURE', true);
  if (deployed && !sessionCookieSecure) {
    throw new ConfigError(
      'SESSION_COOKIE_SECURE=false is only allowed when APP_ENV is development or test',
    );
  }
  const sessionIdleTtlSeconds = int(env, 'SESSION_IDLE_TTL_SECONDS', 7 * DAY_SECONDS);
  const sessionAbsoluteTtlSeconds = int(env, 'SESSION_ABSOLUTE_TTL_SECONDS', 30 * DAY_SECONDS);
  const sessionRotateAfterSeconds = int(env, 'SESSION_ROTATE_AFTER_SECONDS', DAY_SECONDS);
  const telegramOidcStateTtlSeconds = int(env, 'TELEGRAM_OIDC_STATE_TTL_SECONDS', 600);
  for (const value of [
    sessionIdleTtlSeconds,
    sessionAbsoluteTtlSeconds,
    sessionRotateAfterSeconds,
    telegramOidcStateTtlSeconds,
  ]) {
    if (value <= 0) throw new ConfigError('session and login durations must be positive');
  }
  if (sessionIdleTtlSeconds > sessionAbsoluteTtlSeconds) {
    throw new ConfigError('SESSION_IDLE_TTL_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS');
  }
  if (sessionRotateAfterSeconds > sessionAbsoluteTtlSeconds) {
    throw new ConfigError(
      'SESSION_ROTATE_AFTER_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS',
    );
  }
  const sessionRotationGraceSeconds = range(
    'SESSION_ROTATION_GRACE_SECONDS',
    int(env, 'SESSION_ROTATION_GRACE_SECONDS', 60),
    0,
    MAX_ROTATION_GRACE_SECONDS,
  );

  const csrfTrustedOrigins = commaList(env, 'CSRF_TRUSTED_ORIGINS').map((raw, index) => {
    if (raw === '*') throw new ConfigError("CSRF_TRUSTED_ORIGINS must not contain '*'");
    const origin = normalizeOrigin(raw);
    if (origin === null || !isBareOrigin(raw)) {
      throw new ConfigError(
        `CSRF_TRUSTED_ORIGINS entry ${index + 1} must look like scheme://host[:port]`,
      );
    }
    return origin;
  });
  if (deployed) {
    if (csrfTrustedOrigins.length === 0) {
      throw new ConfigError('CSRF_TRUSTED_ORIGINS must list the web and admin origins');
    }
    if (csrfTrustedOrigins.some((origin) => !origin.startsWith('https://'))) {
      throw new ConfigError('CSRF_TRUSTED_ORIGINS must be https:// origins outside development');
    }
  }

  const issuerRaw = text(env, 'TELEGRAM_OIDC_ISSUER') ?? TELEGRAM_OIDC_ISSUER;
  const telegramOidcIssuer = normalizeOrigin(issuerRaw);
  if (telegramOidcIssuer === null || !isBareOrigin(issuerRaw)) {
    throw new ConfigError('TELEGRAM_OIDC_ISSUER must be an origin (scheme://host[:port])');
  }
  if (deployed && telegramOidcIssuer !== TELEGRAM_OIDC_ISSUER) {
    throw new ConfigError('TELEGRAM_OIDC_ISSUER can only be changed in development and test');
  }
  const telegramOidcEnabled = bool(env, 'TELEGRAM_OIDC_ENABLED', false);
  const clientIdRaw = text(env, 'TELEGRAM_OIDC_CLIENT_ID');
  const telegramOidcClientId =
    clientIdRaw === undefined ? null : int(env, 'TELEGRAM_OIDC_CLIENT_ID', 0);
  const telegramOidcClientSecret = text(env, 'TELEGRAM_OIDC_CLIENT_SECRET') ?? null;
  const webPublicOrigin = publicOriginSetting(env, 'WEB_PUBLIC_ORIGIN');
  const adminPublicOrigin = publicOriginSetting(env, 'ADMIN_PUBLIC_ORIGIN');
  if (telegramOidcEnabled) {
    if (telegramOidcClientId === null || telegramOidcClientId <= 0) {
      throw new ConfigError('TELEGRAM_OIDC_ENABLED=true requires TELEGRAM_OIDC_CLIENT_ID');
    }
    if (telegramOidcClientSecret === null) {
      throw new ConfigError('TELEGRAM_OIDC_ENABLED=true requires TELEGRAM_OIDC_CLIENT_SECRET');
    }
    if (webPublicOrigin === null || adminPublicOrigin === null) {
      throw new ConfigError(
        'TELEGRAM_OIDC_ENABLED=true requires WEB_PUBLIC_ORIGIN and ADMIN_PUBLIC_ORIGIN',
      );
    }
    if (webPublicOrigin === adminPublicOrigin) {
      throw new ConfigError('WEB_PUBLIC_ORIGIN and ADMIN_PUBLIC_ORIGIN must differ');
    }
    for (const origin of [webPublicOrigin, adminPublicOrigin]) {
      if (!csrfTrustedOrigins.includes(origin)) {
        throw new ConfigError('WEB/ADMIN_PUBLIC_ORIGIN must be listed in CSRF_TRUSTED_ORIGINS');
      }
      if (deployed && !origin.startsWith('https://')) {
        throw new ConfigError('WEB/ADMIN_PUBLIC_ORIGIN must be https:// outside development');
      }
    }
  }

  const dbRuntimeRole = text(env, 'DB_RUNTIME_ROLE') ?? null;
  if (dbRuntimeRole !== null && !/^[a-z_][a-z0-9_]{0,62}$/.test(dbRuntimeRole)) {
    throw new ConfigError('DB_RUNTIME_ROLE must be a lower-case PostgreSQL role name');
  }
  if (deployed && dbRuntimeRole === null) {
    // The injected DATABASE_URL uses the branch's default role; never run the API with it.
    throw new ConfigError('DB_RUNTIME_ROLE (mm_app) is required outside development');
  }

  const appRelease = text(env, 'APP_RELEASE') ?? null;
  if (appRelease !== null && !RELEASE_RE.test(appRelease)) {
    throw new ConfigError("APP_RELEASE must be 1-64 letters, digits, '.', '_' or '-'");
  }

  return {
    appEnv,
    databaseUrl,
    functionSecret,
    serviceAuthKeys,
    telegramBotId,
    telegramInitDataMaxAgeSeconds,
    telegramEnvironment,
    telegramBotToken: text(env, 'TELEGRAM_BOT_TOKEN') ?? null,
    sessionCookieSecure,
    sessionIdleTtlSeconds,
    sessionAbsoluteTtlSeconds,
    sessionRotateAfterSeconds,
    sessionRotationGraceSeconds,
    csrfTrustedOrigins,
    telegramOidcEnabled,
    telegramOidcClientId,
    telegramOidcClientSecret,
    telegramOidcIssuer,
    webPublicOrigin,
    adminPublicOrigin,
    telegramOidcStateTtlSeconds,
    logLevel: oneOf<LogLevel>(env, 'LOG_LEVEL', ['DEBUG', 'INFO', 'WARNING', 'ERROR'], 'INFO'),
    appRelease,
    dbStatementTimeoutMs: range(
      'DB_STATEMENT_TIMEOUT_MS',
      int(env, 'DB_STATEMENT_TIMEOUT_MS', 15_000),
      0,
      600_000,
    ),
    dbIdleInTransactionTimeoutMs: range(
      'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      int(env, 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 30_000),
      0,
      600_000,
    ),
    dbRuntimeRole,
  };
}
