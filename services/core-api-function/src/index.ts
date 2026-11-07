import { attachDatabasePool } from '@neon/functions';
import { createApp } from './app.ts';
import { loadSettings } from './config.ts';
import { createPool, Database } from './db.ts';
import { systemClock } from './http/context.ts';
import { createLogger } from './logging.ts';

/**
 * Neon Function entry (slug `coreapi`, declared in /neon.ts). Module scope runs once per isolate:
 * settings are validated eagerly (a bad deployment fails at startup, values never logged), and
 * one `pg` pool (max 5) is shared by every request this isolate serves.
 *
 * `DATABASE_URL` is injected by Neon at runtime (pooled). It is never set in neon.ts, a `.env`
 * example or code. Browsers never reach this URL: the Cloudflare gateway Worker is the only
 * caller, authenticated by `CORE_API_FUNCTION_SECRET` on every request.
 */
const settings = loadSettings(process.env);
const pool = createPool(settings.databaseUrl);
attachDatabasePool(pool);

const logger = createLogger({
  level: settings.logLevel,
  release: settings.appRelease,
  env: settings.appEnv,
});

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
