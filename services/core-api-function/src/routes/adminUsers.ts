/**
 * User management (`admin` role only): search users, change a role, block or unblock; port of
 * services/api/app/api/routes/admin_users.py and app/schemas/admin_users.py.
 *
 * Responses never include phone numbers. The shop always keeps at least one active admin
 * (`409 last_admin`) and an admin cannot block themselves (`409 cannot_block_self`). Every change
 * is audited (`user.role_change`, `user.block`, `user.unblock`) with the role/flag values only.
 * Blocking a user or changing their role revokes their sessions in the same transaction.
 */

import { ApiError } from '../errors.ts';
import { auditActorOf } from '../http/auth.ts';
import { deps, type Ctx, type UserRole } from '../http/context.ts';
import {
  ActorNotAdminError,
  AdminUserError,
  AdminUserRepository,
  CannotBlockSelfError,
  LastAdminError,
  UserNotFoundError,
} from '../repositories/adminUsers.ts';
import { adminRead, adminWrite } from './adminCatalog.ts';
import {
  bool,
  int,
  internalError,
  json,
  model,
  nullable,
  ok,
  oneOf,
  optional,
  pageOf,
  pathUuid,
  queryParam,
  queryValues,
  readJsonBody,
  str,
  throwIfInvalid,
  validateBody,
  ValueErr,
  type Issues,
} from './adminCommon.ts';
import type { Router } from './index.ts';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE = 100_000;
const ROLES: readonly UserRole[] = ['customer', 'operator', 'admin'];

function toApiError(error: unknown): unknown {
  if (!(error instanceof AdminUserError)) return error;
  if (error instanceof UserNotFoundError)
    return new ApiError(404, 'user_not_found', 'User not found');
  if (error instanceof LastAdminError) {
    return new ApiError(409, 'last_admin', 'At least one active admin must remain');
  }
  if (error instanceof CannotBlockSelfError) {
    return new ApiError(409, 'cannot_block_self', 'You cannot block yourself');
  }
  if (error instanceof ActorNotAdminError)
    return new ApiError(403, 'forbidden', 'Admin role required');
  return internalError();
}

const UserUpdate = model(
  {
    role: optional(nullable(oneOf(ROLES))),
    is_blocked: optional(nullable(bool)),
  },
  ({ values, fieldsSet }) => {
    if (fieldsSet.size === 0) throw new ValueErr('send role and/or is_blocked');
    for (const name of fieldsSet) {
      if (values[name] === null) throw new ValueErr(`${name} cannot be null`);
    }
  },
);

const repo = (c: Ctx): AdminUserRepository => new AdminUserRepository(deps(c).db);

async function listUsers(c: Ctx): Promise<Response> {
  await adminRead(c);
  const issues: Issues = [];
  const query = queryValues(c);
  const q = queryParam(query, 'q', str({ maxLength: 100 }), null as string | null, issues);
  const role = queryParam(query, 'role', oneOf(ROLES), null as UserRole | null, issues);
  const blocked = queryParam(query, 'blocked', bool, null as boolean | null, issues);
  const page = queryParam(query, 'page', int({ ge: 1, le: MAX_PAGE }), 1, issues);
  const pageSize = queryParam(
    query,
    'page_size',
    int({ ge: 1, le: MAX_PAGE_SIZE }),
    DEFAULT_PAGE_SIZE,
    issues,
  );
  throwIfInvalid(issues);
  const trimmed = (ok(q) ?? '').trim();
  const record = await repo(c).listUsers({
    query: trimmed || null,
    role: ok(role),
    blocked: ok(blocked),
    page: ok(page),
    pageSize: ok(pageSize),
  });
  return json(pageOf(record.items, ok(page), ok(pageSize), record.total));
}

async function updateUser(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'user_id', issues);
  const payload = validateBody(body, UserUpdate, issues);
  throwIfInvalid(issues);
  const { values } = ok(payload);
  try {
    const record = await repo(c).updateUser(
      ok(id),
      {
        role: values['role'] as UserRole | null,
        isBlocked: values['is_blocked'] as boolean | null,
      },
      auditActorOf(admin),
    );
    deps(c).logger.info(`User ${ok(id)} updated by an admin`);
    return json(record);
  } catch (error) {
    throw toApiError(error);
  }
}

export function register(router: Router): void {
  router.get('/admin/users', listUsers);
  router.patch('/admin/users/{user_id}', updateUser);
}
