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

| Target           | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `make lint`      | `ruff check` + `ruff format --check`                            |
| `make format`    | auto-fix and format                                             |
| `make typecheck` | `mypy` (strict)                                                 |
| `make test`      | `pytest` (no database needed)                                   |
| `make build`     | `uv build`, then import-check the built wheel in a clean venv   |

Database-backed tests are marked `@pytest.mark.integration` and are skipped unless
`TEST_DATABASE_URL` is set to a disposable PostgreSQL. They create and drop their own schema.

## Layout

```
app/
  main.py            create_app() factory (uvicorn app.main:create_app --factory)
  core/              settings (env validation), clock, error envelope
  db/                declarative Base (naming convention, UUID pk, timestamps), engine/session
  models/            users, categories, products, carts, orders (money = integer UZS)
  domain/            pure business rules (order status transitions)
  repositories/      persistence behind small interfaces (faked in tests)
  security/          service-to-service request signing (ADR 0003)
  telegram/          initData verification
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
- Request bodies are capped at 64 KiB (8 KiB for `/auth/telegram/init-data`); larger requests get 413.

## Telegram identity (Mini App)

`POST /api/v1/auth/telegram/init-data` verifies `initData` and upserts the user.

- **Default: Ed25519 "third-party validation".** Needs only `TELEGRAM_BOT_ID` and Telegram's
  published public key (`TELEGRAM_ENVIRONMENT` selects the production or test key), so the bot
  token never has to be given to this service.
- **HMAC path:** set `TELEGRAM_BOT_TOKEN` and the service verifies with the classic bot-token HMAC
  instead. Use it only if you cannot use the Ed25519 flow.

Both reject duplicate fields, stale (`TELEGRAM_INIT_DATA_MAX_AGE_SECONDS`) and future-dated
`auth_date`, and require a `user` with an integer `id`. Issuing an HTTP-only session cookie is a
TODO for the catalog/cart phase.

## Internal (Telegram Serverless) routes

`/api/v1/internal/telegram/*` accepts only requests signed per
`architecture/0003-service-auth-contract.md`. The acting Telegram user is part of the signed
material and is required on these routes. Every authentication failure returns the same generic
`401`. The replay store is Redis in deployed environments (`APP_ENV=test` uses an in-memory
store).

## Error format

```json
{"error": {"code": "validation_error", "message": "Request validation failed"}}
```

Unhandled errors return a generic `500`; details are logged server-side only.

## Catalog API (public, no session)

All under `/api/v1`; errors use the envelope above and are documented in OpenAPI. Responses carry
`Cache-Control: public, max-age=60`.

| Endpoint                                                              | Notes                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /categories`                                                     | Active categories as a tree, `sort_order, name_uz, id` at every level. An inactive category hides its whole subtree. |
| `GET /products?category=&q=&sort=&page=1&page_size=24`                | `ProductPage` (`items`, `page`, `page_size`, `total`, `total_pages`). |
| `GET /products/{slug}`                                                | `ProductDetail`; 404 `product_not_found` when missing, inactive, or in a hidden category. |

- A product is visible when it is active **and** its category and every ancestor are active.
- `category` is a slug and includes all visible descendant categories (recursive CTE); an unknown
  or hidden slug is 404 `category_not_found`.
- `q` is trimmed and must be 2-100 characters (else 422). It is an `ILIKE '%q%'` over `name_uz`,
  `name_ru` and `sku`; `%`, `_` and `\` are escaped so they match literally. Migration `0002`
  adds `pg_trgm` GIN indexes on those columns. Case-insensitivity for Cyrillic depends on the
  database's `LC_CTYPE` (UTF-8 locales fold case; the `C` locale does not).
- `sort` is `newest` (default), `price_asc`, `price_desc` or `name`. Every ordering ends with `id`,
  so pages never overlap or skip rows that tie on the sort key. `page >= 1`, `1 <= page_size <= 48`.
  `total_pages` is `ceil(total / page_size)`, so `0` for an empty result; a page beyond the end is
  an empty `items` list, not an error.
- `stock_quantity` is `null` when stock is not tracked; `in_stock` is `false` only for tracked
  stock of `0`. Prices are integer UZS.

## Cart API (session required)

| Endpoint                          | Notes                                                              |
| --------------------------------- | ------------------------------------------------------------------ |
| `GET /cart`                       | Needs a session. Never creates a cart.                              |
| `POST /cart/items`                | `{product_id, quantity 1..99}`; adds to an existing line.           |
| `PUT /cart/items/{product_id}`    | `{quantity 1..99}`; sets the quantity, 404 `cart_item_not_found`.   |
| `DELETE /cart/items/{product_id}` | Idempotent: a missing line still returns the cart.                  |

Writes also require the CSRF token (`CsrfProtectedUserDep`). Reads are limited to 120/min and writes
to 60/min per user. Every response is `Cache-Control: no-store`.

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

## Dev seed

```bash
cd services/api
make migrate          # local database only
make seed             # or from the repo root: pnpm api:seed
```

`python -m app.dev.seed` loads synthetic catalog data (`Demo`/`Демо` names, `DEMO-0001...` SKUs,
round prices, no image URLs). It refuses to run unless `APP_ENV` is `development` or `test`, and is
idempotent: rows are upserted by slug and an unchanged row is not touched, so a second run writes
nothing. The data includes products with an old price, untracked stock, an out-of-stock product, an
inactive product, an inactive category, and an active category under an inactive one (hidden).

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
connection's `search_path` is `"<schema>", public`: tables and the alembic version table live in the
test schema while the `pg_trgm` operator classes (installed once into `public` by the test setup)
resolve. `alembic/env.py` accepts an open connection through `config.attributes["connection"]` for
this; without it behaviour is unchanged. `tests/test_migrations.py` also checks
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
