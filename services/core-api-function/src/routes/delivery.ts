/**
 * Public delivery zones (no authentication), cached like the catalog and limited per IP (port of
 * services/api/app/api/routes/delivery.py).
 */
import { deps, type Ctx } from '../http/context.ts';
import { listActiveZones } from '../repositories/delivery.ts';
import { deliveryZoneList } from '../schemas/storefront/responses.ts';
import { catalogIpLimit, publicJson } from './catalog.ts';
import type { Router } from './index.ts';

/**
 * Active zones with their districts, fees, minimum order and Asia/Tashkent hours. `is_open_now`
 * is as of the response; it may be up to a minute stale from a cache.
 */
async function listZones(c: Ctx): Promise<Response> {
  await catalogIpLimit(c);
  const { db, clock } = deps(c);
  const zones = await listActiveZones(db.pool);
  return publicJson(c, deliveryZoneList(zones, clock()));
}

export function register(router: Router): void {
  router.get('/delivery/zones', listZones);
}
