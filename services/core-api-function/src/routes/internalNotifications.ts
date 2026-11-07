import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { parsePath } from '../http/body.ts';
import { deps } from '../http/context.ts';
import {
  claimOutbox,
  LEASE_SECONDS,
  reportOutbox,
  REPORTED_OUTCOMES,
  type ReportedOutcome,
} from '../repositories/outbox.ts';
import { parseSignedJson, requireServiceWithoutActor } from '../security/serviceAuth.ts';
import type { Router } from './index.ts';

/**
 * Notification outbox for the Telegram transport (port of
 * services/api/app/api/routes/internal_notifications.py, ADR 0008). Signed requests with an EMPTY
 * actor only (ADR 0003). `POST /claim` leases due messages; `POST /{id}/result` reports one.
 */

export const ClaimRequest = z.strictObject({ limit: z.number().int().min(1).max(50).default(20) });

export const ResultRequest = z.strictObject({
  attempt: z.number().int().min(1),
  outcome: z.enum(REPORTED_OUTCOMES as [ReportedOutcome, ...ReportedOutcome[]]),
  error_code: z
    .string()
    .regex(/^[a-z0-9_.-]{1,64}$/)
    .nullish(),
});

const MessageId = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/, {
    message: 'Input should be a valid UUID',
  })
  .transform((value) => {
    const hex = value.replaceAll('-', '').toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });

/** `datetime.fromtimestamp(t, UTC)` serialised like Pydantic (microseconds, `Z`). */
export function isoFromEpoch(seconds: number): string {
  const micros = Math.round(seconds * 1_000_000);
  const date = new Date(Math.floor(micros / 1000));
  const base = date.toISOString().slice(0, 19);
  const fraction = ((micros % 1_000_000) + 1_000_000) % 1_000_000;
  return fraction === 0 ? `${base}Z` : `${base}.${String(fraction).padStart(6, '0')}Z`;
}

export function register(router: Router): void {
  router.post('/internal/telegram/notifications/claim', async (c) => {
    await requireServiceWithoutActor(c);
    const { db, clock } = deps(c);
    const now = clock();
    const payload = await parseSignedJson(c, ClaimRequest, { emptyAs: {} });
    const messages = await claimOutbox(db, { limit: payload.limit, now });
    return c.json({
      items: messages.map((m) => ({
        id: m.id,
        event_type: m.event_type,
        payload: m.payload,
        attempts: m.attempts,
      })),
      lease_expires_at: isoFromEpoch(now + LEASE_SECONDS),
    });
  });

  /**
   * `retry` backs off exponentially and gives up (`failed`) after 8 attempts. 404 when the
   * message is unknown, finished, its lease expired, or it was reclaimed (a newer `attempt`).
   */
  router.post('/internal/telegram/notifications/{message_id}/result', async (c) => {
    await requireServiceWithoutActor(c);
    const { db, clock } = deps(c);
    const now = clock();
    const messageId = parsePath(c, 'message_id', MessageId);
    const payload = await parseSignedJson(c, ResultRequest);
    const found = await reportOutbox(db, messageId, payload.outcome, {
      attempt: payload.attempt,
      errorCode: payload.error_code ?? null,
      now,
    });
    if (!found) throw new ApiError(404, 'not_found', 'Message not found');
    return c.body(null, 204);
  });
}
