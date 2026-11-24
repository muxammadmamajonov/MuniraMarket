import { attachDatabasePool } from '@neon/functions';
import { createApp } from './app.ts';
import { loadSettings } from './config.ts';
import { createPool, Database } from './db.ts';
import { systemClock } from './http/context.ts';
import { createLogger, errorFields } from './logging.ts';

/**
 * Neon Function entry (slug `coreapi`, declared in /neon.ts). Module scope runs once per isolate:
 * settings are validated eagerly (a bad deployment fails at startup, values never logged), and
 * one `pg` pool (max 5) is shared by every request this isolate serves.
 *
 * The pool uses only `MM_APP_DATABASE_URL` (pooled endpoint, role `mm_app`, a Function secret).
 * Neon's injected `DATABASE_URL` (owner role) is never read. Browsers never reach this Function:
 * the Cloudflare gateway Worker is the only caller, authenticated by `CORE_API_FUNCTION_SECRET`
 * on every request.
 */
const settings = loadSettings(process.env);
const logger = createLogger({
  level: settings.logLevel,
  release: settings.appRelease,
  env: settings.appEnv,
});
const logPoolError = (error: Error) =>
  logger.error('Unexpected database pool error', errorFields(error));
const pool = createPool(settings.databaseUrl);
// Unexpected pool errors are logged by class/code only: a driver message can carry the host.
attachDatabasePool(pool, { onUnexpectedError: (error) => logPoolError(error) });

const app = createApp({
  settings,
  db: new Database(pool, {
    statementTimeoutMs: settings.dbStatementTimeoutMs,
    idleInTransactionTimeoutMs: settings.dbIdleInTransactionTimeoutMs,
  }),
  clock: systemClock,
  logger,
  fetch: (input, init) => fetch(input, init),
});

logger.info('core-api function starting', { event: 'startup' });

export default app;
