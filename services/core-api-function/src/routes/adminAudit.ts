/**
 * Audit log reads (`admin` role only; port of services/api/app/api/routes/admin_audit.py). The
 * log is append-only; there is no write route.
 */

import { deps, type Ctx } from '../http/context.ts';
import { AuditRepository } from '../repositories/audit.ts';
import { adminRead } from './adminCatalog.ts';
import {
  int,
  json,
  ok,
  pageOf,
  queryParam,
  queryValues,
  str,
  throwIfInvalid,
  uuid,
  type Issues,
} from './adminCommon.ts';
import type { Router } from './index.ts';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE = 100_000;

async function listAuditEntries(c: Ctx): Promise<Response> {
  await adminRead(c);
  const issues: Issues = [];
  const query = queryValues(c);
  const entityType = queryParam(
    query,
    'entity_type',
    str({ pattern: [/^[a-z_]{1,32}$/, '^[a-z_]{1,32}$'] }),
    null as string | null,
    issues,
  );
  const entityId = queryParam(
    query,
    'entity_id',
    str({ minLength: 1, maxLength: 64 }),
    null as string | null,
    issues,
  );
  const action = queryParam(
    query,
    'action',
    str({ pattern: [/^[a-z_]{1,32}\.[a-z_]{1,31}$/, '^[a-z_]{1,32}\\.[a-z_]{1,31}$'] }),
    null as string | null,
    issues,
  );
  const actorUserId = queryParam(query, 'actor_user_id', uuid, null as string | null, issues);
  const page = queryParam(query, 'page', int({ ge: 1, le: MAX_PAGE }), 1, issues);
  const pageSize = queryParam(
    query,
    'page_size',
    int({ ge: 1, le: MAX_PAGE_SIZE }),
    DEFAULT_PAGE_SIZE,
    issues,
  );
  throwIfInvalid(issues);
  const record = await new AuditRepository(deps(c).db).listEntries(
    {
      entityType: ok(entityType),
      entityId: ok(entityId),
      action: ok(action),
      actorUserId: ok(actorUserId),
    },
    ok(page),
    ok(pageSize),
  );
  return json(pageOf(record.items, ok(page), ok(pageSize), record.total));
}

export function register(router: Router): void {
  router.get('/admin/audit', listAuditEntries);
}
