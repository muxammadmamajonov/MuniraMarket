# MuniraMarket Core API

FastAPI service behind the MuniraMarket web storefront and Telegram Mini App. Python 3.13,
managed with [uv](https://docs.astral.sh/uv/). This document is for local development only; it
contains no credentials, and none belong in this repository.

## Quick start

```bash
cd services/api
make install                 # uv sync --locked
cp .env.example .env         # placeholders only - edit locally, never commit
make run                     # http://127.0.0.1:8000/api/v1/docs (non-production only)
```

`make migrate` applies Alembic migrations. It is for a **local** database only.

| Target           | What it does                                                  |
| ---------------- | ------------------------------------------------------------- |
| `make lint`      | `ruff check` + `ruff format --check`                          |
| `make format`    | auto-fix and format                                           |
| `make typecheck` | `mypy` (strict)                                               |
| `make test`      | `pytest` (no database needed)                                 |
| `make build`     | `uv build`, then import-check the built wheel in a clean venv |

Database-backed tests are marked `@pytest.mark.integration` and are skipped unless
`TEST_DATABASE_URL` is set to a disposable PostgreSQL. They create and drop their own schema.
Real-Redis tests are additionally marked `@pytest.mark.redis` and run only when `TEST_REDIS_URL`
points at a disposable Redis (7+); they use unique key prefixes and delete what they create.

## Layout

```
app/
  main.py            create_app() factory (uvicorn app.main:create_app --factory)
  core/              settings (env validation), clock, error envelope
  db/                declarative Base (naming convention, UUID pk, timestamps), engine/session
  models/            users, catalog, carts, delivery zones + slots, orders + history, outbox,
                     audit log (integer UZS)
  domain/            pure business rules (cart, delivery pricing, checkout quote, order status,
                     catalog CSV, image URLs)
  audit.py           append-only audit writer with the PII allow/deny lists (ADR 0010)
  repositories/      persistence behind small interfaces (faked in tests)
  security/          service request signing (ADR 0003), sessions, CSRF, rate limits (ADR 0007)
  telegram/          initData and Login Widget verification
  api/               routers mounted under /api/v1
alembic/             async migrations; the URL comes from settings, not alembic.ini
tests/
```

## Configuration

All settings are environment variables, validated at startup (the process refuses to start on a
bad value). See `.env.example` for the full list. Highlights:

- `DATABASE_URL` must use the `postgresql+asyncpg://` scheme.
- `SERVICE_AUTH_KEYS` is `key_id:secret[,key_id:secret]`; each secret is at least 32 bytes.
  Two entries allow key rotation.
- `APP_ENV` is required (no default).
- `CORS_ALLOWED_ORIGINS` is a comma-separated list; `*` is always rejected, and staging/production
  require `https://` origins.
- OpenAPI/Swagger is served only when `APP_ENV` is `development` or `test`.
- `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS` defaults to 3600; `TELEGRAM_ENVIRONMENT=test` is rejected
  in production.
- Request bodies are capped at 64 KiB (8 KiB for `/auth/telegram/init-data`, 4 KiB for
  `/auth/telegram/login-widget`); larger requests get 413.
- `SESSION_COOKIE_SECURE` defaults to `true`; `false` is refused outside development/test.
- `CSRF_TRUSTED_ORIGINS` is a comma-separated list of `scheme://host[:port]` origins; `*` is
  rejected and staging/production require `https://`.
- `TELEGRAM_LOGIN_WIDGET_ENABLED=true` requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.
  `TELEGRAM_LOGIN_MAX_AGE_SECONDS` (widget `auth_date` max age) defaults to 600: the redirect flow
  posts the payload right after the user authorises, so a short window suffices and bounds replay.
- `SESSION_ROTATION_GRACE_SECONDS` must be 0..300 (default 60).
- `FORWARDED_ALLOW_IPS` (comma-separated IPs/CIDRs, validated) is required in staging/production
  and may not be `*` there. See "Client IP behind the proxy".

## Telegram identity (Mini App)

`POST /api/v1/auth/telegram/init-data` verifies `initData` and upserts the user.

- **Default: Ed25519 "third-party validation".** Needs only `TELEGRAM_BOT_ID` and Telegram's
  published public key (`TELEGRAM_ENVIRONMENT` selects the production or test key), so the bot
  token never has to be given to this service.
- **HMAC path:** set `TELEGRAM_BOT_TOKEN` and the service verifies with the classic bot-token HMAC
  instead. Use it only if you cannot use the Ed25519 flow.

Both reject duplicate fields, stale (`TELEGRAM_INIT_DATA_MAX_AGE_SECONDS`) and future-dated
`auth_date`, and require a `user` with an integer `id`. Failures return
`401 invalid_telegram_auth`; success starts a browser session (below).

## Browser sessions, CSRF and rate limits

Design and rationale: `architecture/0007-browser-sessions-csrf.md`. Browsers reach these routes
through the web app's same-origin proxy (`/api/v1/[...path]` in `apps/web`), never cross-origin.

| Route                                     | Purpose                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| `GET /api/v1/auth/config`                 | whether the Login Widget is enabled, and the bot username |
| `POST /api/v1/auth/telegram/init-data`    | Mini App sign-in; `{user, csrf_token}` + session cookie   |
| `POST /api/v1/auth/telegram/login-widget` | website sign-in (404 `feature_disabled` unless enabled)   |
| `GET /api/v1/auth/session`                | current user and CSRF token; `401 session_required`       |
| `POST /api/v1/auth/logout`                | deletes the session, expires the cookie (`204`)           |

- **Session cookie**: opaque `secrets.token_urlsafe(32)` in `__Host-mm_session` (`mm_session` when
  `SESSION_COOKIE_SECURE=false` in development), `HttpOnly; SameSite=Lax; Path=/; Secure`, no
  `Domain`, `Max-Age` = remaining absolute lifetime. Redis stores only `sha256(token)` under
  `mm:sess:<hash>`. Idle expiry `SESSION_IDLE_TTL_SECONDS` (7 days, sliding), absolute lifetime
  `SESSION_ABSOLUTE_TTL_SECONDS` (30 days), rotation after `SESSION_ROTATE_AFTER_SECONDS`
  (24 h, CSRF token kept). Every login replaces the session presented with it.
- **Rotation grace**: rotation turns the old key into a tombstone `{"rotated_to": "<new hash>"}`
  for `SESSION_ROTATION_GRACE_SECONDS` (60 s; 0 deletes it). Requests the browser sent in parallel
  with the old cookie resolve to the new session (one hop, never a chain) and are served without a
  second rotation and without `Set-Cookie`. Logout, blocking and re-login through either token
  revoke the whole session. An unknown or expired cookie gets `401 session_required` **without**
  an expiring `Set-Cookie` (it could overwrite a freshly rotated cookie); only logout and explicit
  revocation (blocked user, user mismatch) clear the cookie.
- **CSRF**: unsafe methods need a trusted `Origin` (or `Referer`) and, on authenticated routes,
  `X-CSRF-Token` equal to the `csrf_token` from the login / session response. Without either
  header, requests are refused in staging/production and allowed in development/test. Failure is
  `403 csrf_failed`.
- **Blocking**: the user is re-read on every authenticated request; blocked users get
  `403 account_blocked` and lose the session.
- **Rate limits** (fixed window, `mm:rl:<scope>:<subject>:<window_start>`): sign-in 10/min per IP,
  session lookup and logout 60/min per IP, cart reads 120/min and writes 60/min per user. Per-IP
  ceilings that run **before** any session lookup or database work: `cart_ip` 300/min on every
  `/cart` route and `catalog_ip` 300/min on the catalog reads. `429 rate_limited` carries
  `Retry-After` and is always `Cache-Control: no-store`.
- **Fail closed**: Redis errors on sessions or rate limits return `503 service_unavailable` (this
  includes the catalog, through `catalog_ip`).
- All `/api/v1/auth/*` and `/api/v1/cart/*` responses (errors included) and any response that sets
  the session cookie are `Cache-Control: no-store`. An unhandled exception becomes the generic
  `500 internal_error` inside the cookie middleware, so a cookie rotated earlier in the request is
  still delivered (with `no-store`). Tokens, CSRF tokens, hashes, cookies and `initData` are never
  logged.

### Client IP behind the proxy

Rate limits key on `request.client.host`. The image runs uvicorn with `--proxy-headers`; uvicorn
reads `FORWARDED_ALLOW_IPS` from the environment (0.54: when the flag is not given, the variable,
else `127.0.0.1,::1`) and, when the TCP peer is in that list, replaces the client with the
**right-most `X-Forwarded-For` entry that is not itself trusted**. The application never parses
`X-Forwarded-For`.

- The web proxy (`apps/web`) and the admin proxy (`apps/admin`) are the **only** trusted hops: set
  `FORWARDED_ALLOW_IPS` to their address(es) only, never a whole shared network and never `*`
  (settings refuse `*` and an empty value in staging/production; entries must be valid IPs or
  strict CIDRs, exactly as uvicorn parses them, otherwise uvicorn would silently treat them as
  never-matching literals). Each must also set `CLIENT_IP_HEADER` in staging/production: without
  it every request through that proxy shares one per-IP bucket, and ten sign-in attempts a minute
  from anyone would lock every operator out of the admin sign-in.
- The proxy must forward only an edge-provided client IP, never a browser-supplied
  `X-Forwarded-For` (that is the web app's side of the contract).
- Server-side catalog fetches made directly by the web server carry no `X-Forwarded-For`, so they
  all count against the web server's own address in `catalog_ip`; forward the visitor's IP there
  too, or keep that traffic well under 300/min.

### Using the session in routes and tests

`app/api/auth_deps.py` exports `CurrentUserDep`, `CsrfProtectedUserDep` (all state-changing
routes) and `rate_limit(scope, limit, window_seconds, key="ip" | "user")`. Tests sign in for real
with `tests/auth_helpers.py`, or override `get_current_user` (plus `require_csrf` on write routes
when CSRF is not under test) and optionally `get_rate_limiter` through
`app.dependency_overrides`.

## Internal (Telegram Serverless) routes

`/api/v1/internal/telegram/*` accepts only requests signed per
`architecture/0003-service-auth-contract.md`. The acting Telegram user is part of the signed
material and is required on these routes. Every authentication failure returns the same generic
`401`. The replay store is Redis in deployed environments (`APP_ENV=test` uses an in-memory
store).

## Error format

```json
{ "error": { "code": "validation_error", "message": "Request validation failed" } }
```

Unhandled errors return a generic `500`; details are logged server-side only.

## Catalog API (public, no session)

All under `/api/v1`; errors use the envelope above and are documented in OpenAPI. Successful
responses carry `Cache-Control: public, max-age=60`; `429` (`catalog_ip`, 300/min per IP) is
`no-store`.

| Endpoint                                               | Notes                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /categories`                                      | Active categories as a tree, `sort_order, name_uz, id` at every level. An inactive category hides its whole subtree. |
| `GET /products?category=&q=&sort=&page=1&page_size=24` | `ProductPage` (`items`, `page`, `page_size`, `total`, `total_pages`).                                                |
| `GET /products/{slug}`                                 | `ProductDetail`; 404 `product_not_found` when missing, inactive, or in a hidden category.                            |

- A product is visible when it is active **and** its category and every ancestor are active.
- `category` is a slug and includes all visible descendant categories (recursive CTE); an unknown
  or hidden slug is 404 `category_not_found`.
- `q` is trimmed and must be 2-100 characters (else 422). It is an `ILIKE '%q%'` over `name_uz`,
  `name_ru` and `sku`; `%`, `_` and `\` are escaped so they match literally. Migration `0002`
  adds `pg_trgm` GIN indexes on those columns. Case-insensitivity for Cyrillic depends on the
  database's `LC_CTYPE` (UTF-8 locales fold case; the `C` locale does not).
- The 2-character minimum is deliberate: Uzbek and Russian have meaningful two-letter words
  (e.g. "un", "ош"). Known limitation: `pg_trgm` cannot use its GIN index for a pattern with fewer than
  three characters, so a 2-character `q` is a sequential scan of the visible products. That is
  fine at this catalog size and bounded by `catalog_ip`; revisit (e.g. prefix index or a minimum of
  3) if the catalog grows large.
- `sort` is `newest` (default), `price_asc`, `price_desc` or `name`. Every ordering ends with `id`,
  so pages never overlap or skip rows that tie on the sort key. `page >= 1`, `1 <= page_size <= 48`.
  `total_pages` is `ceil(total / page_size)`, so `0` for an empty result; a page beyond the end is
  an empty `items` list, not an error.
- `stock_quantity` is `null` when stock is not tracked; `in_stock` is `false` only for tracked
  stock of `0`. Prices are integer UZS.

## Cart API (session required)

| Endpoint                          | Notes                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| `GET /cart`                       | Needs a session. Never creates a cart.                            |
| `POST /cart/items`                | `{product_id, quantity 1..99}`; adds to an existing line.         |
| `PUT /cart/items/{product_id}`    | `{quantity 1..99}`; sets the quantity, 404 `cart_item_not_found`. |
| `DELETE /cart/items/{product_id}` | Idempotent: a missing line still returns the cart.                |

Writes also require the CSRF token (`CsrfProtectedUserDep`). Every route is first limited to
300/min per IP (`cart_ip`, before the session lookup); then reads to 120/min and writes to 60/min
per user. Every response, errors included, is `Cache-Control: no-store`.

- The server computes all money. `Cart = {items, item_count, subtotal_uzs, total_uzs, has_issues}`;
  a line is `{product, quantity, line_total_uzs, issue}`. `issue` is `product_inactive` (product or
  any of its categories inactive) or `insufficient_stock` (tracked stock below the line quantity).
  Lines with an issue stay visible and keep their price x quantity `line_total_uzs`, but are left
  out of `item_count`, `subtotal_uzs` and `total_uzs` (which are equal until checkout adds delivery).
- Write errors: 404 `product_not_found`, 409 `product_inactive`, 409 `insufficient_stock`
  (with `available_quantity`), 409 `cart_limit_reached` (a 51st distinct line), 422 (quantity per
  line above 99, e.g. adding to a line that already holds 98), 401/403/429 from the session layer.
  Stock is checked on the resulting line quantity; a stock error wins over the 99 cap.
- The cart does **not** reserve stock; checkout re-validates.
- Each write is one transaction: `INSERT ... ON CONFLICT DO NOTHING` the user's cart, `SELECT ... FOR
UPDATE` that row (this serialises a user's concurrent writes, so stock, the 99 cap and the 50-line
  cap cannot be raced), upsert the line with `ON CONFLICT (cart_id, product_id)`, bump
  `carts.updated_at`. Lines are ordered by when they were added (`cart_items.created_at`, then id).

## Delivery zones (public, no session)

`GET /api/v1/delivery/zones` lists **active** zones in display order: `name_uz/ru`,
`delivery_fee_uzs`, `free_delivery_threshold_uzs` (`null` = never free), `min_order_uzs`,
`opens_at`/`closes_at` (`HH:MM`, Asia/Tashkent), `is_open_now` and the zone's `districts`
(`code`, `name_uz`, `name_ru`). Cached and limited like the catalog (`catalog_ip`).

A zone is a set of whole Tashkent districts (`delivery_zone_districts`; the district is the primary
key, so a district belongs to at most one zone). Matching is by district code only, no geocoding.
Delivery is free once the subtotal reaches the threshold; the minimum order is compared with the
subtotal (before delivery). Orders are accepted at any time; outside the hours they are delivered
from the next opening. Rules: `app/domain/delivery.py`, design: `architecture/0009-checkout-orders.md`.

## Checkout and orders (session required; writes also CSRF)

| Endpoint                         | Notes                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| `POST /checkout/quote`           | `{district}`; re-checks the cart, prices delivery. `CheckoutQuote`.    |
| `POST /orders`                   | `Idempotency-Key` header required; creates the order from the cart.   |
| `GET /orders?page=&page_size=`   | The customer's orders, newest first (`OrderPage`, page size ≤ 50).    |
| `GET /orders/{id}`               | `OrderDetail`; `404 order_not_found` also for other users' orders.     |
| `POST /orders/{id}/cancel`       | `{reason}` (3-300); only `NEW`/`CONFIRMED`; returns tracked stock.     |

- **Delivery slots** (ADR 0010): the quote also returns `slot_required` and `delivery_slots`
  (`id`, `date`, `starts_at`/`ends_at` `HH:MM` Asia/Tashkent, `remaining`, `is_full`; active, cutoff
  in the future, next 14 days, at most 60). A zone with at least one bookable slot requires
  `delivery_slot_id` on `POST /orders` (`409 slot_required`); a zone without slots works as before.
  The order books one place with a single conditional `UPDATE` (`reserved_count < capacity`,
  active, same zone, cutoff ahead) after the product locks; otherwise `409 slot_full` or
  `slot_unavailable`. A `CHECK (reserved_count <= capacity)` is the backstop. Cancelling (customer
  or operator) gives the place back in the same transaction. Orders keep `delivery_slot`
  (date and times) as a snapshot.
- **Quote** never fails because of the cart: `issues` (`cart_empty`, `cart_has_issues`,
  `below_min_order`) and `can_place_order` say what blocks an order. `409 district_not_served`
  when no active zone covers the district.
- **Order body**: structured `address` (`district`, `street`, `house`, optional `apartment`,
  `entrance`, `floor`, `landmark`), `recipient_name`, `recipient_phone` (`+998` and 9 digits;
  spaces, dashes and parentheses are ignored and stored normalised), `payment_method`
  (`cash_on_delivery` | `card_on_delivery`), optional `comment`, and `expected_total_uzs` (the
  quote's `total_uzs`). Text is trimmed, blank optionals become `null`, control characters are
  rejected.
- **Idempotency**: the key is 16-128 characters of `[A-Za-z0-9_-]` (send a UUID), unique per user.
  Same key + same validated body → the original order, `200` with `Idempotent-Replayed: true`.
  Same key + different body → `409 idempotency_key_conflict`. A new attempt needs a new key.
- **Refusals** (nothing is written): `409 cart_empty`, `product_inactive` / `insufficient_stock`
  (with `product_id`, and `available_quantity` for stock), `below_min_order`,
  `district_not_served`, `price_changed` (with the new `total_uzs`: quote again, show it, retry
  with a new key).
- **Transaction**: lock the cart row, check the key, lock the products `FOR UPDATE` in id order,
  re-evaluate with the quote's function, insert the order and the line snapshots (name, SKU, unit,
  unit price, whether stock was taken), decrement tracked stock, empty the cart, append `order_status_history` and a
  `notification_outbox` row. Cancelling returns tracked stock under the same lock order.
- **Open orders**: at most 5 orders in `NEW` per customer (`409 too_many_open_orders`); cash or card
  on delivery costs nothing to place, so this bounds how much stock one account can hold.
- **Limits** (fixed window): `orders_ip` 300/min per IP on every `/checkout` and `/orders` route,
  then per user: quote 60/min, create 10/min, reads 120/min, cancel 20/min. Every response is
  `Cache-Control: no-store`. Addresses and phone numbers are never logged: the engine hides bound
  parameters and unhandled database errors are logged by class, SQLSTATE and constraint only
  (PostgreSQL's "failing row contains" detail would otherwise carry the order row).

## Back office (`operator` / `admin` role)

Design: `architecture/0010-admin-content-ops.md`. Shared dependencies: `app/api/admin_deps.py`.

- **Who**: `operator` works orders and reads the dashboard; `admin` also gets catalog, CSV, zones,
  slots, users and the audit log. The role is re-read from the database on every request and is
  checked **before** any entity is read, so a wrong role gets `403 forbidden` for existing and
  unknown ids alike. Back-office routes accept only Telegram **Login Widget** sessions (the admin
  app's sign-in): a Mini App (`initData`) session is a storefront session and gets `403` here even
  for staff. The storefront proxy answers `404` for `/api/v1/admin/**`; the admin proxy forwards
  only `admin/**` and the Login Widget/session routes.
- **Limits**: `admin_ip` 600/min per IP, reads 300/min and writes 120/min per user, CSV import
  10/min and export 20/min per user. Every write needs the CSRF token. Every response is
  `no-store`. The admin app signs in on its own origin: add it to `CSRF_TRUSTED_ORIGINS`.

| Endpoint                                                  | Role     | Notes                                                                       |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `GET /admin/dashboard`                                    | staff    | today (Asia/Tashkent): orders, `NEW` orders, GMV, average order, cancelled  |
| `GET /admin/orders?status=&page=`, `GET /admin/orders/{id}` | staff  | `AdminOrderDetail`: history with actor role and reason, allowed transitions |
| `PATCH /admin/orders/{id}/status`                         | staff    | `{status, reason?, expected_status?}`                                       |
| `GET/POST /admin/categories`, `PATCH/DELETE …/{id}`       | admin    | flat list with counts; `category_cycle`, `category_not_empty`, `slug_taken` |
| `GET/POST /admin/products`, `GET/PATCH/DELETE …/{id}`     | admin    | `DELETE` archives (soft); `POST …/{id}/restore`; `sku_taken`, `slug_taken`  |
| `GET /admin/catalog/csv/template`, `…/csv/export`         | admin    | `text/csv`, UTF-8 BOM, formula-escaped cells                                |
| `POST /admin/catalog/csv/import?dry_run=`                 | admin    | raw `text/csv` ≤ 1 MiB, ≤ 2000 rows, all-or-nothing                         |
| `GET/POST /admin/delivery/zones`, `PATCH/DELETE …/{id}`   | admin    | districts replaced as a set; `district_taken`, `zone_in_use`               |
| `GET/POST /admin/delivery/slots`, `PATCH/DELETE …/{id}`   | admin    | `capacity_below_reserved`, `slot_in_use`, `slot_exists`                     |
| `GET /admin/users?q=&role=&blocked=`, `PATCH …/{id}`      | admin    | `{role?, is_blocked?}`; `last_admin`, `cannot_block_self`; never the phone  |
| `GET /admin/audit?entity_type=&entity_id=&action=`        | admin    | newest first                                                                |

Order status transitions follow `app/domain/order_status.py` (one step forward, or `CANCELLED` with
a reason from any non-final status); `expected_status` turns a lost update into
`409 order_status_conflict`.

- **Products are never deleted.** Archiving sets `archived_at` and makes the product inactive (a
  `CHECK` enforces it), so it disappears from the storefront and carts (`product_inactive`) while
  order lines keep their snapshot and product reference. An archived product must be restored
  (it comes back inactive) before it can be edited.
- **Image URLs** are `https` links on a public host name (no IP literals, internal suffixes,
  credentials or non-default ports) or `null` (placeholder). The server never fetches them
  (`app/domain/image_url.py`); real uploads come with deployment.
- **CSV** (`app/domain/catalog_csv.py`): columns `sku,slug,category_slug,name_uz,name_ru,
  description_uz,description_ru,unit,price_uzs,old_price_uzs,stock_quantity,is_active,sort_order,
  image_url`, upsert by SKU. UTF-8 only (BOM optional), strict quoting, exact column set. Every row
  is validated (`duplicate_sku`, `invalid_money`, `invalid_stock`, `category_not_found`,
  `invalid_text` for control characters/U+FFFD/mojibake, `formula_not_allowed`, ...), errors are
  returned per row and column (at most 200), and **if any row is wrong nothing is written**.
  `dry_run=true` never writes. Applying re-validates under product row locks in one transaction and
  audits every changed product. Export prefixes text cells starting with `=`, `+`, `-`, `@`, `'`,
  tab or CR with `'`; import reverses exactly that and rejects unescaped formula-like text.
- **Last admin**: role/block changes lock every active admin row (`FOR UPDATE`, id order) and
  refuse to leave no active admin (`409 last_admin`); blocking yourself is `409
  cannot_block_self`. A blocked user's next request is `403 account_blocked`.
- **Audit log** (`app/audit.py`): one append-only row (a trigger rejects `UPDATE`/`DELETE`) per
  catalog, CSV, zone, slot, role/block and order-status change, written in the same transaction.
  `details` keeps only allow-listed fields as `{"from", "to"}` scalars; phone numbers, addresses,
  names, cancel reasons (only `has_reason`), `initData`, cookies and tokens are never recorded.

Locally, give a signed-in user a staff role with
`make set-role TG=<telegram_user_id> ROLE=operator|admin` (development/test only).

## Notification outbox (internal, signed)

Design: `architecture/0008-order-notification-outbox.md`. Every order creation and status change
writes an `order.status_changed` row in the same transaction. The Telegram Serverless transport
drains it with signed requests **without an actor** (an actor gets `403`):

- `POST /internal/telegram/notifications/claim` `{limit 1..50}` leases due rows for 60 s
  (`FOR UPDATE SKIP LOCKED`) and returns `{items, lease_expires_at}`.
- `POST /internal/telegram/notifications/{id}/result` `{attempt, outcome, error_code?}`:
  `delivered`, `recipient_blocked`, `failed`, or `retry` (backoff 30 s doubling to 1 h; `failed`
  after 8 attempts). `attempt` is the `attempts` value from the claim and fences the lease: `404` if
  the row is unknown, finished, never claimed, its lease expired, or it was reclaimed since (so a
  worker that outlived its lease cannot overwrite the current holder's outcome). A row leased 8 times without
  any report (a transport that crashes on it) is retired as `failed` (`max_attempts`).

The payload holds the order id and number, status, locale, total, the Telegram chat id and, when
cancelled, the reason; never the address or phone.

## Dev seed

```bash
cd services/api
make migrate          # local database only
make seed             # or from the repo root: pnpm api:seed
```

`python -m app.dev.seed` loads synthetic catalog data and delivery zones (`Demo`/`Демо` names, `DEMO-0001...` SKUs,
round prices, no image URLs). It refuses to run unless `APP_ENV` is `development` or `test`, and is
idempotent: rows are upserted by slug and an unchanged row is not touched, so a second run writes
nothing. The data includes products with an old price, untracked stock, an out-of-stock product, an
inactive product, an inactive category, and an active category under an inactive one (hidden).
The zones cover Tashkent's districts (each in at most one zone): one with a free-delivery
threshold, one with a higher minimum, one never free, and an inactive zone whose districts are not
served. Delivery slots are seeded only for `demo-chekka` (chilonzor, olmazor, uchtepa, yashnobod):
two windows a day for the next 7 Tashkent days, so checkout there requires a slot while the other
zones keep working without one. Re-running on a later day adds the new days and never touches
`reserved_count`.

## Integration tests

```bash
docker run -d --rm --name mm-api-test-pg -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci-only-password \
  -e POSTGRES_DB=muniramarket_test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgresql+asyncpg://ci:ci-only-password@localhost:55432/muniramarket_test make test
docker stop mm-api-test-pg
```

Without `TEST_DATABASE_URL` the `integration`-marked tests are skipped. With it, each test module
gets a fresh schema (`mm_test_<random>`) built by the **real Alembic migrations** (`upgrade head`,
not `create_all`) and dropped afterwards, so nothing else in the database is touched. The
connection's `search_path` is `"<schema>", public` so the `pg_trgm` operator classes (installed
once into `public` by the test setup) resolve, but migrations do **not** rely on it:
`alembic/env.py` accepts an open connection and the target schema through
`config.attributes["connection"]` / `["schema"]` and then pins the version table
(`version_table_schema`), every unqualified table, index and enum (`schema_translate_map`) and
autogenerate to that schema. A database whose `public` is already migrated and seeded (a developer
database used as `TEST_DATABASE_URL`) is therefore left alone: the harness refuses to migrate a
schema not named `mm_test_*`, fails if the tables did not land in the test schema, and empties
tables between tests with a schema-qualified `TRUNCATE`. Without those attributes `env.py` behaves
as before. `tests/test_migrations.py` also checks
`upgrade head` -> `downgrade base` -> `upgrade head`, that `compare_metadata` reports no difference
between the models and the migrated schema, the `stock_quantity >= 0` constraint, and the trigram
extension and indexes. The migration leaves `pg_trgm` installed on downgrade (extensions are
database-wide).

## Docker

```bash
docker build -t muniramarket-core-api services/api
```

The image is multi-stage, runs as a non-root user and carries no configuration; pass settings as
environment variables at runtime.
