// End-to-end check of the deployed `catalog` Function and Neon Realtime.
//
//   pnpm --filter @muniramarket/neon-functions smoke   (reads ../../.env.local from `neon deploy`)
//
// 1. GET /health on the Function (proves it runs and reaches Postgres).
// 2. POST /catalog/categories/live, subscribe to the sealed query over the Live SQL API.
// 3. Insert a temporary active category, wait for it to arrive live, delete it, wait for it to
//    disappear. The row is always deleted, even when the check fails.
import { createRealtimeClient } from '@neon/realtime/client';
import pg from 'pg';

const functionUrl = process.env.NEON_FUNCTION_CATALOG_BASE_URL;
const realtimeUrl = process.env.NEON_REALTIME_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!functionUrl || !realtimeUrl || !databaseUrl) {
  throw new Error('run `neon deploy --env .env.local` first (missing Neon variables)');
}
const base = functionUrl.replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

function log(step, detail) {
  console.log(`ok  ${step}${detail ? `: ${detail}` : ''}`);
}

const health = await fetch(`${base}/health`);
const healthBody = await health.json();
if (health.status !== 200 || healthBody.status !== 'ok') {
  throw new Error(`function health failed: ${health.status} ${JSON.stringify(healthBody)}`);
}
log('function /health', JSON.stringify(healthBody));

async function seal() {
  const response = await fetch(`${base}/catalog/categories/live`, { method: 'POST' });
  if (!response.ok) throw new Error(`sealing failed: ${response.status}`);
  return response.json();
}

const sealed = await seal();
log('sealed live query', `fingerprint ${sealed.queryFingerprint.slice(0, 12)}…`);

const client = createRealtimeClient({ url: realtimeUrl });
const subscription = client.subscribe(sealed);

function waitFor(predicate, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what}`));
    }, TIMEOUT_MS);
    const stop = subscription.onChange((snapshot) => {
      if (snapshot.status === 'error') {
        clearTimeout(timer);
        stop();
        reject(snapshot.error);
      } else if (snapshot.data !== undefined && predicate(snapshot.data)) {
        clearTimeout(timer);
        stop();
        resolve(snapshot.data);
      }
    });
  });
}

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const slug = `zz-realtime-smoke-${Date.now()}`;
try {
  const initial = await waitFor(() => true, 'the initial result');
  log('initial live result', `${initial.length} active categories`);

  await db.query(
    `INSERT INTO categories (id, slug, name_uz, name_ru, sort_order, is_active)
     VALUES (gen_random_uuid(), $1, 'Realtime smoke', 'Realtime smoke', 9999, true)`,
    [slug],
  );
  const started = Date.now();
  await waitFor((rows) => rows.some((row) => row.slug === slug), 'the inserted row');
  log('insert arrived live', `${Date.now() - started} ms`);
} finally {
  await db.query('DELETE FROM categories WHERE slug = $1', [slug]);
}
await waitFor((rows) => !rows.some((row) => row.slug === slug), 'the delete');
log('delete arrived live');

subscription.unsubscribe();
client.close();
await db.end();
console.log('realtime + functions smoke passed');
