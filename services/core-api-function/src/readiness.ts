/**
 * What "ready" means for the Core API: the database answers and every table and column this
 * release reads exists and is readable by the runtime role.
 *
 * The schema probes are the release's expected schema revision. The runtime role cannot read
 * `alembic_version` (it is the migrator's alone), so the revision is checked by use: `LIMIT 0`
 * reads no rows but fails when a relation or column is missing or ungranted. A Function deployed
 * before its migration ran is therefore unready instead of failing signed-in requests.
 *
 * Add a probe in the same change as any code that starts reading a new table or column. The
 * opposite direction (the schema moved on while an older Function still runs) cannot be detected
 * from this side: that is what expand-then-contract prevents (architecture/0019).
 */

// One probe per security-state table (ADR 0013).
const SECURITY_STATE_PROBES = [
  'SELECT 1 FROM auth_sessions LIMIT 0',
  'SELECT 1 FROM rate_limit_counters LIMIT 0',
  'SELECT 1 FROM service_request_nonces LIMIT 0',
  'SELECT 1 FROM oidc_login_states LIMIT 0',
];

// Objects added by the most recent migrations (0007 courier delivery, 0008 profile addresses,
// 0009 safety stock and shortages), the ones a Function can run ahead of.
const SCHEMA_PROBES = [
  'SELECT total_uzs, subtotal_uzs FROM orders LIMIT 0',
  'SELECT 1 FROM user_addresses LIMIT 0',
  'SELECT birth_date, name_edited_at FROM users LIMIT 0',
  'SELECT safety_stock FROM products LIMIT 0',
  'SELECT original_quantity, adjusted_at FROM order_items LIMIT 0',
  'SELECT 1 FROM order_item_adjustments LIMIT 0',
];

export const READINESS_PROBES: readonly string[] = [
  'SELECT 1',
  ...SECURITY_STATE_PROBES,
  ...SCHEMA_PROBES,
];

/** A passing result is reused this long, so a public `/health/ready` cannot be used to load the DB. */
export const READY_CACHE_MS = 10_000;

export interface ReadinessOptions {
  now?: () => number;
}

/**
 * Returns a function that runs the probes, or answers from a recent success. Failures are never
 * cached: the first request after a fix sees it. The cache lives with the isolate.
 */
export function createReadiness(
  run: (sql: string) => Promise<unknown>,
  { now = Date.now }: ReadinessOptions = {},
): () => Promise<void> {
  let okUntil = 0;
  return async () => {
    if (now() < okUntil) return;
    for (const probe of READINESS_PROBES) await run(probe);
    okUntil = now() + READY_CACHE_MS;
  };
}
