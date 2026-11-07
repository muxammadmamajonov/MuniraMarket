import { afterAll, describe, expect, it } from 'vitest';
import { createPool, Database } from '../../src/db.ts';

/**
 * The Core API's runtime connection is `mm_app` itself (MM_APP_DATABASE_URL), not an owner
 * connection stepping down. Through the Function's own `Database` class it must not change or
 * remove audit rows, run DDL, or switch to any other role.
 *
 * Needs TEST_MM_APP_DATABASE_URL: an mm_app connection to a database migrated by mm_migrator with
 * infra/neon/sql/10-runtime-grants.sql applied. infra/neon/scripts/verify-roles.sh sets that up
 * and runs this file (FUNCTION_ROLE_TEST=1, CI). Skipped otherwise.
 */
const url = process.env['TEST_MM_APP_DATABASE_URL'];

describe.skipIf(url === undefined)('mm_app runtime connection', () => {
  const db = new Database(createPool(url ?? 'postgresql://unused@127.0.0.1:1/unused'));
  afterAll(() => db.pool.end());

  const refused = async (sql: string) => {
    await expect(db.tx((client) => client.query(sql))).rejects.toMatchObject({
      code: expect.stringMatching(/^(42501|0LP01|22023|42704)$/),
    });
  };

  it('connects as mm_app', async () => {
    const { rows } = await db.query<{ u: string; s: string }>(
      'SELECT current_user AS u, session_user AS s',
    );
    expect(rows[0]).toEqual({ u: 'mm_app', s: 'mm_app' });
  });

  it('can append to and read the audit log', async () => {
    await db.tx((client) =>
      client.query(
        `INSERT INTO audit_log (id, actor_role, action, entity_type, entity_id, details)
         VALUES (gen_random_uuid(), 'admin', 'runtime_role.check', 'check', 'fn', '{}'::jsonb)`,
      ),
    );
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'runtime_role.check'",
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['UPDATE audit_log', "UPDATE audit_log SET action = 'x'"],
    ['DELETE audit_log', 'DELETE FROM audit_log'],
    ['TRUNCATE audit_log', 'TRUNCATE audit_log'],
    ['CREATE TABLE', 'CREATE TABLE intruder (id int)'],
    ['ALTER TABLE', 'ALTER TABLE products ADD COLUMN intruder int'],
    ['DROP TABLE', 'DROP TABLE products'],
    ['CREATE ROLE', 'CREATE ROLE intruder'],
    ['SET ROLE mm_migrator', 'SET ROLE mm_migrator'],
    ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION mm_migrator'],
  ])('refuses %s', async (_label, sql) => {
    await refused(sql);
  });

  it('cannot leave mm_app with RESET ROLE or SET ROLE NONE', async () => {
    const roles = await db.tx(async (client) => {
      await client.query('RESET ROLE');
      const a = await client.query<{ u: string }>('SELECT current_user AS u');
      await client.query('SET ROLE NONE');
      const b = await client.query<{ u: string }>('SELECT current_user AS u');
      return [a.rows[0]?.u, b.rows[0]?.u];
    });
    expect(roles).toEqual(['mm_app', 'mm_app']);
  });

  it('holds no elevated attribute and no role membership', async () => {
    const { rows } = await db.query<{ elevated: boolean; memberships: number }>(
      `SELECT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication) AS elevated,
              (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
         FROM pg_roles r WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ elevated: false, memberships: 0 });
  });
});
