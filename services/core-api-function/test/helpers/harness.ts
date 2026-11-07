import type { Hono } from 'hono';
import { createApp } from '../../src/app.ts';
import { loadSettings, type Settings } from '../../src/config.ts';
import { createPool, Database } from '../../src/db.ts';
import type { AppBindings, Clock, Deps, Entrance, FetchFn } from '../../src/http/context.ts';
import { GATEWAY_SECRET_HEADER } from '../../src/http/gatewaySecret.ts';
import { createLogger } from '../../src/logging.ts';

/** Test-only values. Never real secrets. */
export const TEST_GATEWAY_SECRET = 'test-only-secret-not-for-production-0001';
export const TEST_SERVICE_KEY_ID = 'tg';
export const TEST_SERVICE_SECRET = 'test-only-secret-not-for-production-0002';
export const TEST_SCHEDULER_SECRET = 'test-only-secret-not-for-production-0003';
export const TEST_BOT_TOKEN = '123456789:TEST-ONLY-bot-token-abcdefghijklmnopqrstu';
export const WEB_ORIGIN = 'http://localhost:3000';
export const ADMIN_ORIGIN = 'http://localhost:3001';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']?.replace(
  /^postgresql\+asyncpg:/,
  'postgresql:',
);

export function testEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: 'test',
    MM_APP_DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:1/unused',
    CORE_API_FUNCTION_SECRET: TEST_GATEWAY_SECRET,
    SERVICE_AUTH_KEYS: `${TEST_SERVICE_KEY_ID}:${TEST_SERVICE_SECRET},scheduler:${TEST_SCHEDULER_SECRET}`,
    TELEGRAM_BOT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    SESSION_COOKIE_SECURE: 'false',
    CSRF_TRUSTED_ORIGINS: `${WEB_ORIGIN},${ADMIN_ORIGIN}`,
    LOG_LEVEL: 'ERROR',
    ...overrides,
  };
}

export function testSettings(overrides: Record<string, string | undefined> = {}): Settings {
  return loadSettings(testEnv(overrides));
}

let sharedDb: Database | null = null;

/** The integration database, or `null` (tests `describe.skipIf(!hasDatabase)`). */
export function testDatabase(): Database | null {
  if (TEST_DATABASE_URL === undefined) return null;
  sharedDb ??= new Database(createPool(TEST_DATABASE_URL));
  return sharedDb;
}

export const hasDatabase = TEST_DATABASE_URL !== undefined;

/** Empty every application table (schema stays; Alembic owns it). */
export async function resetDatabase(db: Database): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'",
  );
  if (rows.length === 0) return;
  // `audit_log` refuses TRUNCATE (append-only trigger); disable it for this one statement only,
  // like services/api/tests/db_support.py.
  const hasAudit = rows.some((r) => r.tablename === 'audit_log');
  await db.tx(async (client) => {
    if (hasAudit) await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate');
    await client.query(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    if (hasAudit) await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate');
  });
}

export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  db?: Database;
  clock?: Clock;
  fetch?: FetchFn;
}

export function testDeps(options: TestAppOptions = {}): Deps {
  const settings = testSettings(options.env);
  return {
    settings,
    db: options.db ?? testDatabase() ?? new Database(createPool(settings.databaseUrl)),
    clock: options.clock ?? (() => Date.now() / 1000),
    logger: createLogger({ level: 'ERROR' }),
    fetch:
      options.fetch ??
      (async () => {
        throw new Error('network disabled in tests');
      }),
  };
}

export function createTestApp(options: TestAppOptions = {}): Hono<AppBindings> {
  return createApp(testDeps(options));
}

export interface CallOptions {
  entrance?: Entrance;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string | Uint8Array;
  cookie?: string;
  ip?: string;
  /** Omit the gateway secret (or send this value instead). */
  gatewaySecret?: string | null;
}

/** A request as the gateway would forward it (secret, entrance, client IP). */
export function call(
  app: Hono<AppBindings>,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const secret = options.gatewaySecret === undefined ? TEST_GATEWAY_SECRET : options.gatewaySecret;
  if (secret !== null) headers.set(GATEWAY_SECRET_HEADER, secret);
  headers.set('x-mm-entrance', options.entrance ?? 'storefront');
  headers.set('x-forwarded-for', options.ip ?? '203.0.113.10');
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  let body: string | Uint8Array | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    body = options.body;
  }
  return Promise.resolve(
    app.request(`http://function.test${path}`, { method, headers, ...(body ? { body } : {}) }),
  );
}

/** `name=value` pairs from every Set-Cookie on a response. */
export function setCookies(response: Response): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) result.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return result;
}
