import type { Router } from './index.ts';
import { deps } from '../http/context.ts';
import { VERSION } from '../version.ts';

// One probe per security-state table (ADR 0013): a missing migration or grant makes the
// Function unready instead of failing every signed-in request. `LIMIT 0` reads no rows.
const READINESS_PROBES = [
  'SELECT 1',
  'SELECT 1 FROM auth_sessions LIMIT 0',
  'SELECT 1 FROM rate_limit_counters LIMIT 0',
  'SELECT 1 FROM service_request_nonces LIMIT 0',
  'SELECT 1 FROM oidc_login_states LIMIT 0',
];

export function register(router: Router): void {
  /** Liveness: the isolate is up. Touches no dependency. */
  router.get('/health', (c) => c.json({ status: 'ok', service: 'core-api', version: VERSION }));

  /** Readiness: the database answers and the security-state tables are reachable. */
  router.get('/health/ready', async (c) => {
    const { db, logger } = deps(c);
    try {
      for (const probe of READINESS_PROBES) await db.query(probe);
    } catch (error) {
      logger.error('Readiness check failed: database', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return c.json({ status: 'unavailable' }, 503, { 'cache-control': 'no-store' });
    }
    return c.json({ status: 'ok' });
  });
}
