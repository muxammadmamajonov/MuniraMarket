import { deps } from '../http/context.ts';
import { deleteExpired } from '../repositories/securityState.ts';
import { requireServiceWithoutActor } from '../security/serviceAuth.ts';
import type { Router } from './index.ts';

/**
 * Housekeeping for the scheduler (port of services/api/app/api/routes/internal_maintenance.py,
 * ADR 0013/0015). Signed, empty actor only.
 */
export function register(router: Router): void {
  /**
   * Delete expired sessions, rate-limit windows, replay nonces and OIDC login states.
   * Correctness never depends on this (readers filter on `expires_at`); it only bounds table
   * size. Safe to call concurrently and repeatedly.
   */
  router.post('/internal/maintenance/cleanup', async (c) => {
    await requireServiceWithoutActor(c);
    const { db, clock, logger } = deps(c);
    const removed = await deleteExpired(db, clock());
    logger.info('Expired security state removed', { event: 'cleanup', ...removed });
    return c.body(null, 204);
  });
}
