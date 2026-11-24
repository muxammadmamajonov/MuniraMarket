# ADR 0015 — Staff order group (`/connect_orders`) and the notification drain trigger

- Status: accepted
- Builds on: [0008](0008-order-notification-outbox.md), [0003](0003-service-auth-contract.md)
- Updated by: [0017](0017-yandex-go-courier-delivery.md) (a NEW-order alert carries the delivery
  point inside a "Yandex chaqirish" button); 2026-11-13, owner's request (below: a NEW-order alert
  carries the order details); [0018](0018-stock-shortage-and-safety-stock.md) (shortage alerts)

## Context

Staff want every new order and the important status changes in a Telegram group, and the outbox
of ADR 0008 has had no trigger. Telegram Serverless documents exactly four kinds of code —
`endpoints/`, `handlers/`, `lib/`, `schema.js` (https://core.telegram.org/bots/serverless) —
handlers run per Telegram update and endpoints only for a Mini App user with valid `initData`.
There is no scheduler, cron, timer or server-to-server trigger. A drain that piggybacks on user
traffic would leave notifications waiting whenever nobody uses the bot, so it is not acceptable.

## Decision

- **Trigger: a Cloudflare Cron Trigger on the existing gateway Worker** (`* * * * *`, the finest
  documented interval; https://developers.cloudflare.com/workers/configuration/cron-triggers/).
  `scheduled()` runs the very same `drainOrderNotifications()` from
  `services/telegram/tgcloud/lib/notifications/outbox.js` (pure ESM, imported, not ported) with
  the same ADR 0003 signer, against the container through an internal `scheduler` entrance that
  allows only the claim/result routes and `internal/maintenance/cleanup` (never via the public
  hostname). Messages go out through a minimal Bot API adapter using the gateway's existing
  `TELEGRAM_BOT_TOKEN` secret. Every 15th minute it also calls the cleanup route (ADR 0013).
  - Signing key: the `SERVICE_AUTH_KEYS` entry named by `SCHEDULER_SERVICE_KEY_ID` (default
    `scheduler`); missing or weak → the tick logs and does nothing (fail closed).
  - Overlapping or repeated ticks are safe: claims use `FOR UPDATE SKIP LOCKED`, leases and the
    `attempt` fencing token, so delivery stays at-least-once with retries and backoff unchanged.
  - Cost: the per-minute tick keeps one container instance awake.
- **`/connect_orders`** (Serverless `handlers/message.js` → `lib/bot/connectOrders.js`): only in a
  `group`/`supergroup`, only as `/connect_orders` or `/connect_orders@<this bot>`, never from an
  anonymous admin or channel. The bot sends a signed request with the sender as actor to
  `POST /api/v1/internal/telegram/staff-chat/connect`; Core API locks the user row and accepts
  only a non-blocked `admin`, then stores the chat id and writes an audit entry (without the id).
  Replies are Uzbek + Russian; errors reveal nothing.
- **Where the chat id lives**: in Core API's PostgreSQL (`staff_notification_chat`, a single row),
  i.e. server-side operational storage, not in the Serverless DB: the drain runs on Cloudflare and
  could not read the Serverless DB, and the role check and the write belong in one transaction.
  It is never exposed by a public or back-office route, never sent to a browser, never in Git.
- **Staff alerts**: in the same transaction as the order change, an `order.staff_alert` outbox row
  is added when a group is connected and the new status is `NEW`, `OUT_FOR_DELIVERY`, `DELIVERED`
  or `CANCELLED` (with “cancelled by the customer” when it was). Payload: order id/number, status,
  previous status, total, group chat id — originally no customer name, address or phone (see the
  update below).

## Update (2026-11-13): the staff alert carries the order details

On the owner's request, staff must be able to act on a new order from Telegram without opening
the admin first. The decision above ("no customer name, address or phone") is relaxed for the
connected staff group only:

- Every `order.staff_alert` carries `recipient_name`. A `NEW` alert also carries `details`: the
  lines (Uzbek name, quantity and unit, line total), subtotal, payment method, recipient phone,
  the address parts (street, house, apartment, entrance, floor, landmark), the customer's comment
  and the creation time. The delivery point still travels only as `destination`, into the Yandex
  Go button URL.
- The message is Uzbek Telegram HTML; every value from the payload is escaped, so nothing a
  customer typed can add markup or links. It stays within Telegram's 4096 characters by cutting
  the item list ("+N ta mahsulot"). Other alerts stay short (number, status, recipient, total).
- Each alert also gets an "Adminda ochish" URL button to `<ADMIN_PUBLIC_ORIGIN>/uz/orders/<id>`
  when that origin is a configured `https://` origin; the order page itself still requires a
  staff session.
- Boundaries kept: the payload is written in the same transaction as the order change, lives in
  Core API's PostgreSQL next to the order (and is deleted with it), and is delivered **only** to
  the chat id stored by `/connect_orders` (an admin-connected private staff group). It is never
  logged, never in an error code, never sent to a customer chat, a channel or any other service.
  Customer notifications (`order.status_changed`, `order.adjusted`) still carry no address or
  phone. Anyone added to the staff group sees customers' names, phones and addresses: membership
  of that group is now a data-access decision for the owner.

## Consequences

- Notifications no longer depend on bot traffic; latency is about one minute.
- `SERVICE_AUTH_KEYS` (gateway and Core API) must contain the scheduler key; Telegram Serverless
  keeps its own key in `service_config`.
- A group upgraded to a supergroup gets a new chat id and must run `/connect_orders` again; a bot
  removed from the group makes deliveries end as `recipient_blocked`.
