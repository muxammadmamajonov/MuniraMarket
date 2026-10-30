# ADR 0008 — Order notifications through a transactional outbox

- Status: accepted
- Supersedes: [0005](0005-order-notifications-delivery.md)

## Context

Customers must hear about every order status change in Telegram. Status changes happen in Core
API; Telegram Serverless code runs only for incoming updates and Mini App endpoint calls, and
documents no scheduler or external trigger. Core API should not hold the bot token (ADR 0002,
0004), and a notification must never be sent for a change that was rolled back, nor lost for one
that committed.

## Decision

- **Outbox in Core API.** Order creation and every status change insert one
  `notification_outbox` row (`order.status_changed`) in the _same transaction_ as the change. The
  payload is what the message needs and nothing more: order id and number, status, locale, total,
  the recipient's Telegram chat id and, for cancellations, the reason. No address or phone.
- **Pull, not push.** A transport claims due rows through signed internal routes (ADR 0003, empty
  actor): `POST /api/v1/internal/telegram/notifications/claim` leases up to 50 rows for 60 s
  (`FOR UPDATE SKIP LOCKED`, so concurrent drainers never share a row) and
  `POST .../{id}/result` reports `delivered`, `recipient_blocked`, `retry` (exponential backoff,
  `failed` after 8 attempts) or `failed`. Unreported rows become claimable again when the lease
  expires: delivery is at-least-once.
- **Transport behind an interface.** `services/telegram/tgcloud/lib/notifications/` defines a
  `NotificationTransport` (`deliver(notification) → outcome`), a Bot API implementation built on
  the existing message builder, and `drainOrderNotifications()` which claims, delivers and
  reports. It is dependency-injected and unit-tested; it holds no credentials.
- **No trigger is wired yet.** Nothing calls the drain today. When a trigger exists (a documented
  Serverless scheduler/trigger, or opportunistic draining on update traffic), a thin handler calls
  `drainOrderNotifications()`; no Core API change is needed.

## Consequences

- Notifications are exactly as reliable as the database transaction that changed the order, and
  the outbox doubles as an audit of what was (or could not be) sent.
- Latency depends on how often the drain runs; until a trigger is wired, rows accumulate (bounded:
  one per status change). Monitoring the pending count is an operational follow-up.
- Another channel (SMS, e-mail, a Core API-side Bot API sender if that is ever preferred) is a
  new transport against the same claim/report contract.
- At-least-once delivery means a customer can, rarely, get the same status message twice (a
  transport that crashed after sending but before reporting).
