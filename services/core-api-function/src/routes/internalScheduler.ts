import { ApiError, notFound } from '../errors.ts';
import { deps } from '../http/context.ts';
import { drainOutbox } from '../scheduler/drain.ts';
import { requireServiceWithoutActor } from '../security/serviceAuth.ts';
import { errorFields } from '../logging.ts';
import type { Router } from './index.ts';

/**
 * Scheduler work moved off the Cloudflare free-plan Cron Trigger (10 ms CPU), which now only
 * signs (ADR 0003, empty actor) and forwards through the gateway's `scheduler` entrance.
 *
 * `POST /internal/scheduler/notifications/drain` drains the order-notification outbox with the
 * bot's own drain and Bot API transport (src/scheduler/drain.ts): 20 messages per claim, at most
 * 5 claims. Retry-safe: overlapping or duplicated calls never claim the same row twice
 * (`FOR UPDATE SKIP LOCKED` + 60 s lease), a stale worker cannot overwrite an outcome (`attempt`
 * fencing), and undelivered messages become claimable again once the lease expires. The answer
 * carries counts only: never ids, chat ids or order data.
 */
export function register(router: Router): void {
  router.post('/internal/scheduler/notifications/drain', async (c) => {
    // Only the gateway's scheduler entrance reaches this route; anywhere else it does not exist.
    if (c.get('entrance') !== 'scheduler') throw notFound();
    await requireServiceWithoutActor(c);
    const { settings, db, clock, logger } = deps(c);
    const token = settings.telegramBotToken;
    if (token === null || token.trim() === '') {
      logger.error('Outbox drain skipped: TELEGRAM_BOT_TOKEN is not configured');
      throw new ApiError(503, 'service_unavailable', 'Service temporarily unavailable');
    }
    let counts;
    try {
      counts = await drainOutbox({
        db,
        clock: () => clock(),
        fetch: deps(c).fetch,
        botToken: token,
      });
    } catch (error) {
      logger.error('Outbox drain failed', errorFields(error));
      throw error;
    }
    if (counts.claimed > 0) logger.info('Outbox drained', { event: 'outbox_drain', ...counts });
    return c.json(counts);
  });
}
