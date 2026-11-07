# @muniramarket/telegram

Telegram Serverless part of MuniraMarket: the bot handler(s) and Mini App endpoints that run on
Telegram's own infrastructure (Telegram Serverless,
`tgcloud` CLI 0.2.0). It is a thin layer. **All business data and rules live in the Core API
(PostgreSQL)**; this service only talks to users on Telegram and calls the Core API on their
behalf using signed requests ([ADR 0003](../../architecture/0003-service-auth-contract.md)).

## What it does today

| Piece                     | File                                                          | Behaviour                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start` handler          | `tgcloud/handlers/message.js` -> `lib/bot/start.js`           | Syncs the Telegram user to the Core API (best effort), replies in uz/ru with a button that opens the Main Mini App. Private chats only.                                                                       |
| `/connect_orders` handler | `tgcloud/handlers/message.js` -> `lib/bot/connectOrders.js`   | Inside the staff group: asks the Core API to make this group the order-alert chat, authorised as the sender. See [Staff group](#staff-group-connect_orders).                                                  |
| `getProfile` endpoint     | `tgcloud/endpoints/getProfile.js` -> `lib/miniapp/profile.js` | Identity is the platform-verified `ctx.initData.user` only (never `input`). Calls the Core API and returns `{ user }`; any failure becomes `EndpointError` with `{ code: 'PROFILE_UNAVAILABLE' }`.            |
| Core API signer/client    | `tgcloud/lib/coreApi/`                                        | HMAC-SHA256 request signing exactly per ADR 0003, incl. its test vector.                                                                                                                                      |
| Crypto                    | `tgcloud/lib/crypto/`                                         | Dependency-free UTF-8, SHA-256, HMAC-SHA256 (WebCrypto is not documented in the runtime). Tested against `node:crypto`.                                                                                       |
| Config                    | `tgcloud/lib/config.js`, `tgcloud/schema.js`                  | Reads `service_config` from the Serverless DB; fails closed.                                                                                                                                                  |
| Order notifications       | `tgcloud/lib/notifications/`                                  | Customer status messages, staff group alerts, the transport and the outbox drain ([ADR 0008](../../architecture/0008-order-notification-outbox.md)). **Run by the api-gateway Worker's Cron Trigger**, below. |

Every other message is ignored.

## Staff group: `/connect_orders`

Order alerts for staff go to ONE Telegram group (or supergroup). To connect it:

1. Add the bot to the staff group (group -> Add members -> the bot). It needs no admin rights,
   only permission to send messages.
2. A MuniraMarket **admin** (role `admin` in the Core API, not blocked) sends
   `/connect_orders` in that group from their personal account. With the bot's privacy mode on
   (the BotFather default) the bot still receives commands, and `/connect_orders@<bot_username>`
   is always delivered to the bot it names.
3. The bot replies (Uzbek, then Russian) that the group is connected. From then on new orders and
   important status changes (cancelled, out for delivery, delivered) are posted there.

Rules (`lib/bot/connectOrders.js`):

- Recognised text: `/connect_orders` or `/connect_orders@<bot>`; the bot part is compared
  case-insensitively with `bot_username` from `service_config` (else `getMe`). A command
  addressed to another bot is ignored silently.
- Group or supergroup only. In a private chat the bot explains (uz + ru) that the command works
  only inside the staff group; channels are ignored.
- Anonymous admins (`sender_chat` set, or `from` is GroupAnonymousBot `1087968824`) and channel
  senders are refused with a request to send it from a personal account (turn off "Remain
  anonymous").
- The Core API call `POST /api/v1/internal/telegram/staff-chat/connect` is signed (ADR 0003) with
  actor `tg:<message.from.id>` (the platform-verified update, never message text) and body
  `{"chat_id": <negative id>, "chat_type": "group" | "supergroup"}`. 200 -> "connected"; 403 ->
  "only a MuniraMarket admin can connect the group" (nothing else revealed); anything else,
  including missing config -> "could not connect now, try later". The chat id, tokens and the
  Core API response never appear in replies or logs.
- The Core API stores the group chat id in its own PostgreSQL; nothing is stored in the
  Serverless DB. Running `/connect_orders` in another group moves the alerts there. If a group is
  upgraded to a supergroup its id changes: run `/connect_orders` again in the supergroup.

## Order notifications: outbox drain

[ADR 0008](../../architecture/0008-order-notification-outbox.md): the Core API writes notification
outbox rows in the same transaction as every order status change. They are _drained_ by
`drainOrderNotifications` in this package, but **not from Telegram Serverless**: the platform's
only entry points are `handlers/<update_type>.js` (Telegram updates), `endpoints/<name>.js`
(callable only from the bot's Mini App with valid initData), `lib/` and `schema.js`
([Telegram Serverless docs](https://core.telegram.org/bots/serverless)). There is no scheduler,
cron or background trigger, and no traffic-driven drain is used.

**Trigger:** a Cloudflare Cron Trigger on the api-gateway Worker
([`services/api-gateway`](../api-gateway/README.md), `src/scheduler.ts`) runs every minute (UTC)
and only signs `POST /api/v1/internal/scheduler/notifications/drain` with `createCoreApiClient`
(ADR 0016: Workers Free plan, 10 ms CPU). The Core API Neon Function
([`services/core-api-function`](../core-api-function/README.md)) then runs the SAME modules from
`tgcloud/lib/`: `drainOrderNotifications` and `createTelegramBotTransport` over a minimal Bot API
adapter using the Function's `TELEGRAM_BOT_TOKEN`, with the claim/report calls going straight to
the outbox tables. Keep `lib/coreApi/` and `lib/notifications/` dependency-free plain ESM: the
gateway bundles the signer and the Function bundles the drain; their only `sdk` import
(`BotApiError`) is aliased to a stand-in there.

| Piece                                                                     | File                                                | Role                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `claimNotifications`, `reportNotification`                                | `lib/coreApi/client.js`                             | Signed calls with an EMPTY actor (the drain acts for the service, never for a user).                                                  |
| `NotificationTransport`, `createTelegramBotTransport({ api })`            | `lib/notifications/transport.js`                    | `deliver(notification)` resolves to `{ outcome, errorCode? }`; customer messages and staff alerts, both plain text (no `parse_mode`). |
| `buildOrderStatusMessage`, `buildStaffAlertMessage`                       | `lib/notifications/orderStatus.js`, `staffAlert.js` | Message texts.                                                                                                                        |
| `drainOrderNotifications({ coreApi, transport, limit, maxBatches, now })` | `lib/notifications/outbox.js`                       | Claim, validate, deliver sequentially, report; returns a summary.                                                                     |

**Core API contract** (signed per ADR 0003, empty actor; 401 for any auth failure, 403 if an actor is sent):

- `POST /api/v1/internal/telegram/notifications/claim` with `{"limit": 1..50}` returns
  `{"items": [{id, event_type, payload, attempts}], "lease_expires_at"}`. The lease is 60 s; a
  message not reported before it expires is claimable again (at-least-once).
- `POST /api/v1/internal/telegram/notifications/{id}/result` with
  `{"attempt", "outcome": "delivered" | "recipient_blocked" | "retry" | "failed", "error_code"?}`
  returns 204, or 404 when the message is unknown, finished, never claimed, its lease expired, or
  it was reclaimed since. `attempt` is the item's `attempts` from the claim: a fencing token, so a
  worker that outlived its lease cannot overwrite the outcome of the worker that reclaimed it. `retry` backs off on the server and
  becomes `failed` after 8 attempts. `error_code` matches `^[a-z0-9_.-]{1,64}$`.
- `order.status_changed` payload (to the customer): `order_id`, `order_number`, `status`,
  `locale` (`uz`|`ru`), `total_uzs` (integer), `chat_id` (integer > 0), optional `cancel_reason`.
  No address or phone.
- `order.staff_alert` payload (to the connected staff group; enqueued for NEW, CANCELLED,
  OUT_FOR_DELIVERY and DELIVERED when a group is connected): `order_id`, `order_number`, `status`,
  `previous_status` (status or `null`), `total_uzs`, `chat_id` (negative group id),
  `cancelled_by_customer` (boolean). No customer PII. The message is one bilingual text: Uzbek
  lines (headline + order number, status with the previous status when known, total, "cancelled
  by the customer" when true), a blank line, then the same in Russian.

**Outcome mapping** (`createTelegramBotTransport`): sent -> `delivered`; Bot API 403 ->
`recipient_blocked` (customer blocked the bot, or the bot was removed from the staff group);
Bot API 401 (bad or rotated token), 429 or >= 500 -> `retry` `bot_api_<code>`; other Bot API 4xx ->
`failed` `bot_api_<code>`; unusable notification -> `failed` `invalid_payload`; anything else
(network) -> `retry` `transport_error`. The drain itself reports `failed` `unknown_event` for an
unknown `event_type` and `failed` `invalid_payload` for a malformed payload. Error codes never
contain message text or user data, and nothing from a payload is logged.

**Drain behaviour:** messages are delivered one at a time. Before each one the remaining lease is
checked; with less than 10 s left the rest of the batch is left alone (`skipped`) and redelivered
after the lease expires. A report that fails (network, 404 after a lost lease) never stops the
batch; it is counted in `reportFailed`. Summary:
`{ claimed, delivered, blocked, retried, failed, skipped, reportFailed }`. If the first claim
fails, `drainOrderNotifications` rejects with the `CoreApiError`; the gateway catches and logs it.
Overlapping drains (a late cron tick) are safe because of the lease and the `attempt` fencing.

## Layout

```
services/telegram/
  tgcloud.jsonc            # tgcloud project config ($schema only; no static hosting yet)
  tgcloud/                 # the ONLY thing that is deployed (plain ESM .js)
    schema.js              # Serverless DB tables (service_config)
    handlers/message.js    # update handler: /connect_orders, /start
    endpoints/getProfile.js
    lib/                   # config, i18n, crypto/, coreApi/, bot/, miniapp/, notifications/
  test/                    # vitest; test/sdk-fake/ is a local double of the `sdk` modules
  types/sdk.d.ts           # ambient types for `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch`
  eslint.config.js  tsconfig.json  vitest.config.js
```

Runtime rules enforced by lint and tests: modules under `tgcloud/` import only `sdk`, `sdk/db`,
`sdk/api`, `sdk/fetch` and relative `.js` files; no npm packages, no Node built-ins, no
`Buffer`/`TextEncoder`/`URL`/WebCrypto; `handlers/` and `endpoints/` are flat; no foreign keys.
Files are plain JavaScript with JSDoc types (`// @ts-check`) because the platform deploys only `.js`.
`lib/coreApi/` and `lib/notifications/` are also bundled by `services/api-gateway` (Cron
Trigger): run its tests too when changing them.

## Commands

From the repository root:

```bash
pnpm --filter @muniramarket/telegram lint        # eslint (flat config, @eslint/js recommended + runtime rules)
pnpm --filter @muniramarket/telegram typecheck   # tsc --noEmit, checkJs strict over tgcloud/ + types/
pnpm --filter @muniramarket/telegram test        # vitest (node env), `sdk*` aliased to test/sdk-fake/
```

Tests never contact Telegram or the Core API.

## Operator runbook (manual, once per environment)

Nothing below is automated or stored in the repository. Never commit tokens, the signing secret or
bot usernames. `.tgcloud/` is local CLI state (it holds the CLI access token): git-ignored, never
committed.

1. **Enable Serverless** for the bot in @BotFather: your bot -> Serverless -> turn on.
2. **Log the CLI in** (interactive terminal only): `npx tgcloud login` and paste the CLI access
   token from @BotFather -> your bot -> Serverless -> CLI Access. It is a different token from the
   bot's API token and is stored in the git-ignored `.tgcloud/`. In CI use `TGCLOUD_TOKEN`.
3. **Deploy**: `npx tgcloud push` (modules), then `npx tgcloud migrate` to create `service_config`.
   Check `npx tgcloud webhook` is in sync with the handlers.
4. **Set the Main Mini App URL** in @BotFather (Mini App settings of the bot). The Mini App
   front-end is not hosted by this project yet (see open decisions), so this is the URL of
   wherever it is hosted.
5. **Insert the `service_config` rows** (table `service_config`, columns `key`, `value`):

   | key                 | value                                                                                                                            | required    |
   | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
   | `core_api_base_url` | Core API origin, `https://...` (http allowed only for localhost), no path                                                        | yes         |
   | `service_key_id`    | key id, `[A-Za-z0-9_-]{1,32}`, must exist in the Core API's `SERVICE_AUTH_KEYS`                                                  | yes         |
   | `service_secret`    | signing secret, at least 32 bytes, matching the Core API key                                                                     | yes         |
   | `mini_app_url`      | https URL of the Main Mini App (used for the `web_app` button)                                                                   | recommended |
   | `bot_username`      | bot username without `@`; the `https://t.me/<bot>?startapp` fallback button, and matching `/connect_orders@<bot>` (else `getMe`) | recommended |

   **TODO (pending confirmation of a supported secret store):** the mechanism for inserting the
   rows, especially `service_secret`, is not defined. The docs describe no secret store,
   environment variables, or console for raw DB writes. Candidate approaches (BotFather database
   screen, a one-off `tgcloud run` module, a temporary admin handler) all put the secret in a
   place we have not verified as safe. Do not improvise: confirm first.

**Deploying a change** (e.g. this release: `/connect_orders` and staff alerts):

```bash
cd services/telegram
npx tgcloud push       # upload the changed modules (handlers/message.js, lib/)
npx tgcloud webhook    # check the webhook's update types still match handlers/ (message)
```

No `npx tgcloud migrate` is needed unless `tgcloud/schema.js` changed (this release does not touch
it). The outbox drain needs nothing here: it is deployed with the api-gateway Worker (its Cron
Trigger), see [services/api-gateway](../api-gateway/README.md). Then connect the staff group
([Staff group](#staff-group-connect_orders)).

`/connect_orders` needs `core_api_base_url`, `service_key_id` and `service_secret`; without them
it answers "could not connect now".

Behaviour without config: `/start` still greets the user (no button if neither `mini_app_url` nor
`bot_username` is set, logged as a warning) and skips the Core API sync; `getProfile` fails with
`PROFILE_UNAVAILABLE`. The signer never runs with a missing or weak secret.

## Open decisions

1. **Mini App hosting.** `tgcloud.jsonc` deliberately has no `static` block; whether the Mini App
   is hosted on tgcloud.ai or elsewhere is pending.
2. **Secret storage** for `service_secret` (see the TODO above).

## Open questions (assumptions beyond the official docs)

Everything here is outside what the Telegram docs state. Each one is isolated and cheap to change.

- **Runtime globals.** `TextEncoder`, `URL`, WebCrypto, `AbortController`, `setTimeout`,
  `Buffer` are undocumented, so none is required. `AbortController`/`setTimeout` are used only
  behind `typeof` guards for the request timeout; if absent (or if the SDK `fetch` ignores
  `signal`) there is no timeout. `globalThis.crypto.getRandomValues` is used for nonces if present,
  else a timestamp + counter + `Math.random` fallback (nonces need uniqueness, not secrecy).
- **`fetch` request bodies.** The signed JSON bytes are sent as a `Uint8Array` body (documented as
  supported) with an explicit `Content-Type: application/json`. Assumed: custom headers
  (`X-MM-*`, `Accept`) are passed through unchanged, and the response `text()` works on non-2xx.
- **Outbound HTTPS from Serverless to the Core API** is assumed allowed (the docs describe `fetch`
  as unrestricted outbound HTTP, up to a 30 MB response cap).
- **Isolate lifetime.** Config is read from the DB on every invocation; no cross-invocation
  caching is assumed.
- **`service_config` access.** Assumes rows can be inserted by an operator out-of-band, and that
  no other bot code or Mini App user can read them (only code inside the project reaches `db`).
- **`db` API.** `select().from(table).all()` returns rows keyed by the schema's JS property names
  (per the Drizzle-style DSL). `timestamp` columns are read as `Date` and not used by this code.
- **Core API contract** (written by another team member, not yet verified against it): the
  session route returns JSON with a top-level `user` object; request fields `last_name`,
  `username`, `language_code` are sent as `null` when absent; `X-MM-Actor` is always sent, empty
  when no user acts (ADR 0003 allows an empty actor).
- **`message.chat.type`.** `/start` is only answered in private chats (or when the type is
  absent, which keeps `tgcloud run` payloads simple). `/connect_orders` acts only in `group` /
  `supergroup` chats.
- **Replies to `/connect_orders`** use the Bot API `reply_parameters` (with
  `allow_sending_without_reply`), passed through the SDK `api.sendMessage` unchanged.
- **Inline `web_app` button.** Uses the documented `InlineKeyboardButton.web_app` with the
  configured URL. The Main Mini App itself must still be configured in @BotFather.
- **Telegram IDs.** Up to 52 significant bits (per the Mini Apps docs), so plain JS numbers are
  safe; the client rejects non-safe-integer IDs.
