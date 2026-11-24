/** Audit log reads over HTTP and the append-only guarantee (port of test_audit_integration.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/audit.ts';
import type { Database } from '../../src/db.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import { adminCall, errorOf, jsonOf, staff, type Actor } from './admin-helpers.ts';

const AUDIT = '/api/v1/admin/audit';
const TARGET = '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10';

describe.skipIf(!hasDatabase)('admin audit log', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let admin: Actor;

  beforeEach(async () => {
    await resetDatabase(db);
    admin = await staff(db, 'admin');
    await db.tx(async (client) => {
      const actor = { userId: admin.user.id, role: 'admin' as const };
      for (let index = 0; index < 3; index += 1) {
        await recordAudit(client, actor, {
          action: 'product.update',
          entityType: 'product',
          entityId: TARGET,
          changes: { price_uzs: [index, index + 1], phone: ['+998', '+999'] },
        });
      }
      await recordAudit(client, actor, {
        action: 'category.create',
        entityType: 'category',
        entityId: '11111111-1111-4111-8111-111111111111',
      });
    });
  });

  it('admins read the log newest first, filtered and paginated', async () => {
    const response = await adminCall(app, admin, 'GET', AUDIT);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body).toMatchObject({ page: 1, page_size: 50, total: 4, total_pages: 1 });
    expect(body.items.map((item: { action: string }) => item.action)).toEqual([
      'category.create',
      'product.update',
      'product.update',
      'product.update',
    ]);
    expect(Object.keys(body.items[0])).toEqual([
      'id',
      'created_at',
      'actor_user_id',
      'actor_role',
      'action',
      'entity_type',
      'entity_id',
      'details',
    ]);
    expect(body.items[0].details).toEqual({});

    const filtered = await jsonOf(
      adminCall(app, admin, 'GET', `${AUDIT}?entity_type=product&entity_id=${TARGET}&page_size=2`),
    );
    expect(filtered).toMatchObject({ total: 3, total_pages: 2, page_size: 2 });
    expect(
      filtered.items.map(
        (item: { details: { changes: { price_uzs: { to: number } } } }) =>
          item.details.changes.price_uzs.to,
      ),
    ).toEqual([3, 2]);
    expect(filtered.items[0].details).toEqual({ changes: { price_uzs: { from: 2, to: 3 } } });
    expect(filtered.items[0]).toMatchObject({ actor_role: 'admin', actor_user_id: admin.user.id });

    const second = await jsonOf(
      adminCall(app, admin, 'GET', `${AUDIT}?entity_type=product&page=2&page_size=2`),
    );
    expect(second.items).toHaveLength(1);
    const beyond = await jsonOf(adminCall(app, admin, 'GET', `${AUDIT}?page=5`));
    expect(beyond).toEqual({ items: [], page: 5, page_size: 50, total: 4, total_pages: 1 });
    const byAction = await jsonOf(
      adminCall(
        app,
        admin,
        'GET',
        `${AUDIT}?action=category.create&actor_user_id=${admin.user.id}`,
      ),
    );
    expect(byAction.total).toBe(1);
  });

  it('query validation', async () => {
    const response = await adminCall(
      app,
      admin,
      'GET',
      `${AUDIT}?entity_type=Product&action=update&actor_user_id=x&page_size=101&entity_id=`,
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details).toEqual([
      { loc: ['query', 'entity_type'], msg: "String should match pattern '^[a-z_]{1,32}$'" },
      { loc: ['query', 'entity_id'], msg: 'String should have at least 1 character' },
      {
        loc: ['query', 'action'],
        msg: "String should match pattern '^[a-z_]{1,32}\\.[a-z_]{1,31}$'",
      },
      { loc: ['query', 'actor_user_id'], msg: 'Input should be a valid UUID' },
      { loc: ['query', 'page_size'], msg: 'Input should be less than or equal to 100' },
    ]);
  });

  it('operators cannot read it', async () => {
    const response = await adminCall(app, await staff(db, 'operator'), 'GET', AUDIT);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
  });

  it('the log is append-only', async () => {
    await expect(db.query("UPDATE audit_log SET action = 'x.y'")).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});
