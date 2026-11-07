import type { Database } from '../db.ts';

/**
 * Notification outbox draining (port of services/api/app/repositories/outbox.py, ADR 0008).
 *
 * A transport claims a batch of due rows with a lease (`FOR UPDATE SKIP LOCKED`, so concurrent
 * claims never get the same row), delivers them and reports one outcome per row, fenced by the
 * claim's `attempts`. A row whose lease expires without a report becomes claimable again, so
 * delivery is at-least-once. Times are the injectable clock's epoch seconds.
 */

export const LEASE_SECONDS = 60;
export const MAX_ATTEMPTS = 8;

export type ReportedOutcome = 'delivered' | 'recipient_blocked' | 'retry' | 'failed';
export const REPORTED_OUTCOMES: readonly ReportedOutcome[] = [
  'delivered',
  'recipient_blocked',
  'retry',
  'failed',
];

/** Backoff after the `attempts`-th failure: 30 s, 1 min, 2 min, ... capped at 1 h. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

export interface OutboxMessage {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function claimOutbox(
  db: Database,
  options: { limit: number; now: number },
): Promise<OutboxMessage[]> {
  const { limit, now } = options;
  return db.tx(async (client) => {
    // A message whose delivery keeps crashing the transport before it reports is never reported
    // at all; retire it once its lease ran out at the attempt limit.
    await client.query(
      `UPDATE notification_outbox
       SET processed_at = to_timestamp($1::float8), outcome = 'failed',
           last_error = 'max_attempts', locked_until = NULL
       WHERE processed_at IS NULL AND attempts >= $2
         AND (locked_until IS NULL OR locked_until <= to_timestamp($1::float8))`,
      [now, MAX_ATTEMPTS],
    );
    const { rows } = await client.query<OutboxMessage>(
      `WITH claimed AS (
         UPDATE notification_outbox
         SET locked_until = to_timestamp($1::float8) + make_interval(secs => $3),
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM notification_outbox
           WHERE processed_at IS NULL AND available_at <= to_timestamp($1::float8)
             AND (locked_until IS NULL OR locked_until <= to_timestamp($1::float8))
           ORDER BY created_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
         RETURNING id, event_type, payload, attempts, created_at)
       SELECT id::text AS id, event_type, payload, attempts FROM claimed ORDER BY created_at, id`,
      [now, limit, LEASE_SECONDS],
    );
    return rows;
  });
}

/**
 * Record the outcome of claim number `attempt` of an unfinished message whose lease has not
 * expired; `false` otherwise (unknown, finished, expired or reclaimed).
 */
export async function reportOutbox(
  db: Database,
  messageId: string,
  outcome: ReportedOutcome,
  options: { attempt: number; errorCode: string | null; now: number },
): Promise<boolean> {
  const { attempt, errorCode, now } = options;
  return db.tx(async (client) => {
    const { rows } = await client.query<{ attempts: number }>(
      `SELECT attempts FROM notification_outbox
       WHERE id = $1::uuid AND processed_at IS NULL AND locked_until IS NOT NULL
         AND attempts = $2 AND locked_until > to_timestamp($3::float8)
       FOR UPDATE`,
      // Fencing: only the holder of the current lease may report. A worker that finishes after
      // its lease expired, or after another worker reclaimed the row (which bumps `attempts`),
      // must not overwrite that outcome.
      [messageId, attempt, now],
    );
    const message = rows[0];
    if (message === undefined) return false;
    if (outcome === 'retry' && message.attempts < MAX_ATTEMPTS) {
      await client.query(
        `UPDATE notification_outbox SET locked_until = NULL, last_error = $2,
           available_at = to_timestamp($3::float8) + make_interval(secs => $4)
         WHERE id = $1::uuid`,
        [messageId, errorCode, now, retryDelaySeconds(message.attempts)],
      );
    } else {
      const final = outcome === 'retry' ? 'failed' : outcome;
      await client.query(
        `UPDATE notification_outbox SET locked_until = NULL, last_error = $2,
           processed_at = to_timestamp($3::float8), outcome = $4
         WHERE id = $1::uuid`,
        [messageId, errorCode, now, final],
      );
    }
    return true;
  });
}
