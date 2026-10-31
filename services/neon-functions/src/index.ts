// Neon Function `catalog` (neon.ts): runs on the Neon branch next to its Postgres.
//
//   GET  /health                 -> {"status":"ok"} once Postgres answers SELECT 1
//   POST /catalog/categories/live -> a sealed Realtime live query of the active categories
//
// The live query only exposes what GET /api/v1/categories already serves publicly, so
// sealing it needs no user. A query that depends on a user must verify a Neon Auth JWT here first
// and bind the user id as a parameter. Sealed queries are bearer capabilities valid ~60 s; the
// client renews by POSTing again (same query => same fingerprint).
import { attachDatabasePool } from '@neon/functions';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { Pool } from 'pg';

export type LiveCategory = {
  id: string;
  parent_id: string | null;
  slug: string;
  name_uz: string;
  name_ru: string;
  sort_order: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const databaseUrl = required('DATABASE_URL');
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
attachDatabasePool(pool);

const realtime = createRealtime({
  secret: required('NEON_REALTIME_SECRET'),
  db: new URL(databaseUrl).pathname.slice(1),
});

const activeCategories = rawSql<LiveCategory>(
  `SELECT id, parent_id, slug, name_uz, name_ru, sort_order FROM categories
   WHERE is_active ORDER BY sort_order, slug LIMIT 200`,
);

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      try {
        await pool.query('SELECT 1');
        return json({ status: 'ok', branch: process.env.NEON_BRANCH ?? null });
      } catch {
        return json({ status: 'unavailable' }, 503);
      }
    }
    if (request.method === 'POST' && pathname === '/catalog/categories/live') {
      return json(await realtime.seal({ query: activeCategories }));
    }
    return json({ error: { code: 'not_found', message: 'Not Found' } }, 404);
  },
};
