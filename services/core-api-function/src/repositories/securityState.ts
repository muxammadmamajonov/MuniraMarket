import type { Database } from '../db.ts';

/**
 * Cleanup of expired security state (port of services/api/app/repositories/security_state.py,
 * ADR 0013). Readers ignore expired rows on their own, so this only reclaims space. Deletes run
 * in bounded batches (`ctid IN (SELECT ... LIMIT n)`), each committed on its own, so one run
 * never holds long locks; it is safe to run concurrently and repeatedly.
 */

export const BATCH_SIZE = 5000;
export const MAX_BATCHES_PER_TABLE = 20;

// Static SQL per table (no identifier formatting at runtime).
const EXPIRED_DELETES: ReadonlyArray<readonly [string, string]> = [
  [
    'auth_sessions',
    'DELETE FROM auth_sessions WHERE ctid IN ' +
      '(SELECT ctid FROM auth_sessions WHERE expires_at <= to_timestamp($1::float8) LIMIT $2)',
  ],
  [
    'rate_limit_counters',
    'DELETE FROM rate_limit_counters WHERE ctid IN ' +
      '(SELECT ctid FROM rate_limit_counters WHERE expires_at <= to_timestamp($1::float8) LIMIT $2)',
  ],
  [
    'service_request_nonces',
    'DELETE FROM service_request_nonces WHERE ctid IN ' +
      '(SELECT ctid FROM service_request_nonces WHERE expires_at <= to_timestamp($1::float8) LIMIT $2)',
  ],
  [
    'oidc_login_states',
    'DELETE FROM oidc_login_states WHERE ctid IN ' +
      '(SELECT ctid FROM oidc_login_states WHERE expires_at <= to_timestamp($1::float8) LIMIT $2)',
  ],
];

/** Delete expired rows table by table; returns the number of rows removed per table. */
export async function deleteExpired(
  db: Database,
  now: number,
  batchSize: number = BATCH_SIZE,
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const [table, statement] of EXPIRED_DELETES) {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const result = await db.query(statement, [now, batchSize]);
      const count = result.rowCount ?? 0;
      total += count;
      if (count < batchSize) break;
    }
    removed[table] = total;
  }
  return removed;
}
