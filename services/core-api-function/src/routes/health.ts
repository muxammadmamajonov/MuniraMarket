import type { Router } from './index.ts';
import { deps } from '../http/context.ts';
import { createReadiness } from '../readiness.ts';
import { VERSION } from '../version.ts';

export function register(router: Router): void {
  // One per isolate, so its short-lived "ready" answer is shared by every request.
  let readiness: ReturnType<typeof createReadiness> | undefined;

  /** Liveness: the isolate is up. Touches no dependency. */
  router.get('/health', (c) => c.json({ status: 'ok', service: 'core-api', version: VERSION }));

  /** Readiness: the database answers and this release's schema (src/readiness.ts) is in place. */
  router.get('/health/ready', async (c) => {
    const { db, logger } = deps(c);
    readiness ??= createReadiness((sql) => db.query(sql));
    try {
      await readiness();
    } catch (error) {
      logger.error('Readiness check failed: database', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return c.json({ status: 'unavailable' }, 503, { 'cache-control': 'no-store' });
    }
    return c.json({ status: 'ok' });
  });
}
