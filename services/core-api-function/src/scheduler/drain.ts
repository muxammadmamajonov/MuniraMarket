import type { Database } from '../db.ts';
import type { Clock, FetchFn } from '../http/context.ts';
import {
  claimOutbox,
  LEASE_SECONDS,
  reportOutbox,
  REPORTED_OUTCOMES,
  type ReportedOutcome,
} from '../repositories/outbox.ts';
import { isoFromEpoch } from '../routes/internalNotifications.ts';
import { drainOrderNotifications } from '../../../telegram/tgcloud/lib/notifications/outbox.js';
import { createTelegramBotTransport } from '../../../telegram/tgcloud/lib/notifications/transport.js';
import { createBotApi } from './botApi.ts';

/**
 * The outbox drain the Cloudflare Cron Trigger used to run (services/api-gateway/src/scheduler.ts),
 * moved into the Function: the free-plan Cron Trigger only signs and forwards. It runs the SAME
 * dependency-free modules the bot ships (`services/telegram/tgcloud/lib/notifications`) against an
 * in-process `OutboxCoreApi` that calls the outbox repository directly with exactly the semantics
 * of the internal claim and result routes (60 s lease, `attempt` fencing, at-least-once).
 */

export const DRAIN_LIMIT = 20;
export const DRAIN_MAX_BATCHES = 5;
const MAX_CLAIM_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE_RE = /^[a-z0-9_.-]{1,64}$/;

export interface DrainCounts {
  claimed: number;
  delivered: number;
  blocked: number;
  retried: number;
  failed: number;
  skipped: number;
  report_failed: number;
}

/** What `reportNotification` rejects with when the claim/result route would answer 404. */
export class OutboxReportRefused extends Error {
  readonly status = 404;
  constructor() {
    super('Message not found');
    this.name = 'OutboxReportRefused';
  }
}

/** In-process stand-in for the Core API client's `claimNotifications` / `reportNotification`. */
export function inProcessOutboxApi(db: Database, clock: Clock) {
  return {
    async claimNotifications({ limit }: { limit: number }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_LIMIT) {
        throw new TypeError('Invalid claim limit');
      }
      const now = clock();
      const items = await claimOutbox(db, { limit, now });
      return {
        items: items.map((m) => ({
          id: m.id,
          event_type: m.event_type,
          payload: m.payload,
          attempts: m.attempts,
        })),
        lease_expires_at: isoFromEpoch(now + LEASE_SECONDS),
      };
    },

    async reportNotification(
      id: string,
      result: { attempt: number; outcome: string; errorCode?: string },
    ): Promise<null> {
      if (!UUID_RE.test(id)) throw new TypeError('Invalid id');
      if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) {
        throw new TypeError('Invalid attempt');
      }
      if (!(REPORTED_OUTCOMES as readonly string[]).includes(result.outcome)) {
        throw new TypeError('Invalid outcome');
      }
      if (result.errorCode !== undefined && !ERROR_CODE_RE.test(result.errorCode)) {
        throw new TypeError('Invalid error code');
      }
      const found = await reportOutbox(db, id.toLowerCase(), result.outcome as ReportedOutcome, {
        attempt: result.attempt,
        errorCode: result.errorCode ?? null,
        now: clock(),
      });
      if (!found) throw new OutboxReportRefused();
      return null;
    },
  };
}

/** One drain run: up to `DRAIN_MAX_BATCHES` claims of `DRAIN_LIMIT` messages. Counts only. */
export async function drainOutbox(options: {
  db: Database;
  clock: Clock;
  fetch: FetchFn;
  botToken: string;
}): Promise<DrainCounts> {
  const summary = await drainOrderNotifications({
    coreApi: inProcessOutboxApi(options.db, options.clock),
    transport: createTelegramBotTransport({ api: createBotApi(options.botToken, options.fetch) }),
    limit: DRAIN_LIMIT,
    maxBatches: DRAIN_MAX_BATCHES,
    now: () => options.clock() * 1000,
  });
  return {
    claimed: summary.claimed,
    delivered: summary.delivered,
    blocked: summary.blocked,
    retried: summary.retried,
    failed: summary.failed,
    skipped: summary.skipped,
    report_failed: summary.reportFailed,
  };
}
