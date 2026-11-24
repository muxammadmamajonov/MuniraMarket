/** Admin user management over HTTP (port of test_admin_users_{api,integration}.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import { createSession, createUser } from '../helpers/fixtures.ts';
import {
  adminCall,
  auditRows,
  customer,
  errorOf,
  jsonOf,
  staff,
  type Actor,
} from './admin-helpers.ts';

const USERS = '/api/v1/admin/users';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!hasDatabase)('admin users', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let admin: Actor;

  const patch = (actor: Actor, userId: string, json: unknown) =>
    adminCall(app, actor, 'PATCH', `${USERS}/${userId}`, { json });
  const sessionsOf = async (userId: string) =>
    (await db.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rows.length;

  beforeEach(async () => {
    await resetDatabase(db);
    admin = await staff(db, 'admin');
  });

  it('the last admin cannot remove themselves (demote or block)', async () => {
    const demote = await patch(admin, admin.user.id, { role: 'operator' });
    expect(demote.status).toBe(409);
    expect(await errorOf(demote)).toEqual({
      code: 'last_admin',
      message: 'At least one active admin must remain',
    });
    const block = await patch(admin, admin.user.id, { is_blocked: true });
    expect(block.status).toBe(409);
    expect((await errorOf(block)).code).toBe('cannot_block_self');
    expect(await auditRows(db)).toEqual([]);
  });

  it('cannot block self even with other admins; blocking an admin counts as removing one', async () => {
    const other = await staff(db, 'admin');
    expect((await errorOf(await patch(admin, admin.user.id, { is_blocked: true }))).code).toBe(
      'cannot_block_self',
    );
    const blocked = await patch(admin, other.user.id, { is_blocked: true });
    expect(blocked.status).toBe(200);
    expect((await errorOf(await patch(admin, admin.user.id, { role: 'customer' }))).code).toBe(
      'last_admin',
    );
    // Demoting yourself while another active admin exists is allowed.
    const third = await staff(db, 'admin');
    expect((await patch(admin, admin.user.id, { role: 'operator' })).status).toBe(200);
    // The demoted admin's session was revoked with the change.
    expect(await sessionsOf(admin.user.id)).toBe(0);
    expect((await adminCall(app, admin, 'GET', USERS)).status).toBe(401);
    expect((await adminCall(app, third, 'GET', USERS)).status).toBe(200);
  });

  it('two admins demoting each other concurrently leave one admin', async () => {
    for (const kind of [{ role: 'customer' }, { is_blocked: true }, { role: 'operator' }]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await resetDatabase(db);
        const first = await staff(db, 'admin');
        const second = await staff(db, 'admin');
        const responses = await Promise.all([
          patch(first, second.user.id, kind),
          patch(second, first.user.id, kind),
        ]);
        const statuses = responses.map((r) => r.status).sort();
        expect(statuses[0]).toBe(200);
        // The loser is refused: `last_admin` when it got past the role check before the winner
        // committed (as in the reference), else its session was revoked or its role re-read.
        expect([401, 403, 409]).toContain(statuses[1]);
        const { rows } = await db.query(
          "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_blocked IS false",
        );
        expect(rows[0]!.n).toBe(1);
      }
    }
  });

  it('role change and block are audited without personal data; sessions revoked on block', async () => {
    const target = await customer(db);
    await createSession(db, target.user, { entrance: 'storefront' });
    expect(await sessionsOf(target.user.id)).toBe(2);

    const promoted = await patch(admin, target.user.id, { role: 'operator' });
    expect(promoted.status).toBe(200);
    const body = await jsonOf(promoted);
    expect(Object.keys(body)).toEqual([
      'id',
      'telegram_user_id',
      'first_name',
      'last_name',
      'username',
      'language',
      'role',
      'is_blocked',
      'created_at',
    ]);
    expect(body).toMatchObject({
      id: target.user.id,
      role: 'operator',
      is_blocked: false,
      language: 'uz',
    });
    expect(await sessionsOf(target.user.id)).toBe(0);

    await createSession(db, target.user, { entrance: 'storefront' });
    const blocked = await patch(admin, target.user.id, { is_blocked: true, role: 'operator' });
    expect(await jsonOf(blocked)).toMatchObject({ role: 'operator', is_blocked: true });
    expect(await sessionsOf(target.user.id)).toBe(0);
    const unblocked = await patch(admin, target.user.id, { is_blocked: false });
    expect((await jsonOf(unblocked)).is_blocked).toBe(false);

    const audit = await auditRows(db);
    expect(audit.map((row) => [row.action, row.entity_type, row.entity_id, row.details])).toEqual([
      [
        'user.role_change',
        'user',
        target.user.id,
        { changes: { role: { from: 'customer', to: 'operator' } } },
      ],
      [
        'user.block',
        'user',
        target.user.id,
        { changes: { is_blocked: { from: false, to: true } } },
      ],
      [
        'user.unblock',
        'user',
        target.user.id,
        { changes: { is_blocked: { from: true, to: false } } },
      ],
    ]);
    expect(JSON.stringify(audit)).not.toContain(target.user.first_name);
  });

  it('a blocked user is refused on the next request', async () => {
    const operator = await staff(db, 'operator');
    expect((await adminCall(app, operator, 'GET', '/api/v1/admin/dashboard')).status).toBe(200);
    expect((await patch(admin, operator.user.id, { is_blocked: true })).status).toBe(200);
    const refused = await adminCall(app, operator, 'GET', '/api/v1/admin/dashboard');
    expect([401, 403]).toContain(refused.status);
  });

  it('unknown user is 404; validation', async () => {
    const missing = await patch(admin, UNKNOWN, { role: 'admin' });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('user_not_found');
    const empty = await patch(admin, UNKNOWN, {});
    expect((await errorOf(empty)).details).toEqual([
      { loc: ['body'], msg: 'Value error, send role and/or is_blocked' },
    ]);
    const nullRole = await patch(admin, UNKNOWN, { role: null });
    expect((await errorOf(nullRole)).details).toEqual([
      { loc: ['body'], msg: 'Value error, role cannot be null' },
    ]);
    const badRole = await patch(admin, UNKNOWN, { role: 'root' });
    expect((await errorOf(badRole)).details).toEqual([
      { loc: ['body', 'role'], msg: "Input should be 'customer', 'operator' or 'admin'" },
    ]);
  });

  it('list and search', async () => {
    const alice = await createUser(db, {
      first_name: 'Alisher_demo',
      telegram_user_id: 555_000_111,
    });
    await createUser(db, { first_name: 'Bobur', role: 'operator', is_blocked: true });
    const all = await jsonOf(adminCall(app, admin, 'GET', USERS));
    expect(all).toMatchObject({ page: 1, page_size: 20, total: 3, total_pages: 1 });
    expect(all.items.map((u: { first_name: string }) => u.first_name)).toEqual([
      'Bobur',
      'Alisher_demo',
      'Test',
    ]);
    expect(JSON.stringify(all)).not.toContain('phone');
    const byName = await jsonOf(adminCall(app, admin, 'GET', `${USERS}?q=%20alisher%20`));
    expect(byName.items.map((u: { id: string }) => u.id)).toEqual([alice.id]);
    const byTelegramId = await jsonOf(adminCall(app, admin, 'GET', `${USERS}?q=555000111`));
    expect(byTelegramId.items.map((u: { id: string }) => u.id)).toEqual([alice.id]);
    const underscore = await jsonOf(adminCall(app, admin, 'GET', `${USERS}?q=_`));
    expect(underscore.items.map((u: { id: string }) => u.id)).toEqual([alice.id]);
    const blocked = await jsonOf(
      adminCall(app, admin, 'GET', `${USERS}?blocked=true&role=operator`),
    );
    expect(blocked.items.map((u: { first_name: string }) => u.first_name)).toEqual(['Bobur']);
    const page = await jsonOf(adminCall(app, admin, 'GET', `${USERS}?page=2&page_size=2`));
    expect(page).toMatchObject({ total: 3, total_pages: 2 });
    expect(page.items).toHaveLength(1);
    const bad = await adminCall(app, admin, 'GET', `${USERS}?role=root&blocked=maybe&page_size=0`);
    expect((await errorOf(bad)).details).toEqual([
      { loc: ['query', 'role'], msg: "Input should be 'customer', 'operator' or 'admin'" },
      {
        loc: ['query', 'blocked'],
        msg: 'Input should be a valid boolean, unable to interpret input',
      },
      { loc: ['query', 'page_size'], msg: 'Input should be greater than or equal to 1' },
    ]);
  });

  it('operators and customers get 403; writes need CSRF', async () => {
    const target = await createUser(db);
    for (const actor of [await staff(db, 'operator'), await customer(db)]) {
      expect((await adminCall(app, actor, 'GET', USERS)).status).toBe(403);
      expect((await patch(actor, target.id, { role: 'admin' })).status).toBe(403);
      expect((await patch(actor, UNKNOWN, { role: 'admin' })).status).toBe(403);
    }
    const noCsrf = await adminCall(app, admin, 'PATCH', `${USERS}/${target.id}`, {
      json: { role: 'admin' },
      noCsrf: true,
    });
    expect(noCsrf.status).toBe(403);
    expect((await errorOf(noCsrf)).code).toBe('csrf_failed');
    expect(await auditRows(db)).toEqual([]);
  });
});
