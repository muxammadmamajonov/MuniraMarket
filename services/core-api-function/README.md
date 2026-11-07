# Core API — Neon Function `coreapi`

The production Core API: catalog, cart, checkout, orders, delivery, profile/auth (Telegram Mini
App `initData` and OIDC), admin back office, internal Telegram/order-group routes, audit and
maintenance. Hono + `pg` on Node.js 24, deployed as the Neon Function with the permanent slug
`coreapi` ([`/neon.ts`](../../neon.ts)). Design: [ADR 0016](../../architecture/0016-core-api-on-neon-functions.md).

The FastAPI app in [`services/api`](../api) is the behavioural reference and owns the OpenAPI
document and the Alembic migrations; it is not deployed.

```
web / admin Worker ─(service binding)─▶ api-gateway Worker ─(X-MM-Gateway-Secret)─▶ coreapi ─▶ Postgres
```

Browsers never call this Function. Every request without the gateway secret is `401`, before any
body is read or the database is touched.

## Layout

| Path                                                 | What                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                                       | Function entry: settings, module-scope pool (`max: 5`), app          |
| `src/app.ts`                                         | middleware: request id/access log, gateway secret, cookies, no-store |
| `src/config.ts`                                      | validated settings (fail fast, values never echoed)                  |
| `src/db.ts`                                          | pool (`mm_app` only), `tx()` (one transaction per unit of work)      |
| `src/http/*`                                         | context, body limits/validation, auth dependencies, serialization    |
| `src/security/*`, `src/telegram/*`                   | sessions, CSRF, rate limits, service signatures, initData, OIDC      |
| `src/routes/*`, `src/repositories/*`, `src/domain/*` | endpoints, SQL, business rules (one file per FastAPI module)         |
| `scripts/dev-server.ts`                              | local gateway stand-in on `:8000` (development/test only)            |

## Environment

The runtime connection is **`MM_APP_DATABASE_URL`** only: Neon's pooled endpoint, user `mm_app`,
`mm_app`'s own password, `sslmode=require`. Outside development the Function refuses to start if
it is missing, not TLS, not `mm_app`, without a password or not the `-pooler` host; the error never
contains any part of the URL. Neon may inject `DATABASE_URL`/`DATABASE_URL_UNPOOLED` (owner role):
the code never reads them, and nobody sets `DATABASE_URL` by hand. Migrations stay on Alembic with
the direct `mm_migrator` URL.

Secrets (declared by name in `neon.ts`, values only in the git-ignored `--env` file):

| Name                          | Notes                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| `MM_APP_DATABASE_URL`         | pooled endpoint, `mm_app` + its own password, `sslmode=require`         |
| `CORE_API_FUNCTION_SECRET`    | ≥ 32 bytes; same value as the gateway Worker secret                     |
| `SERVICE_AUTH_KEYS`           | `key_id:secret[,…]`, each ≥ 32 bytes; must contain `scheduler:<secret>` |
| `TELEGRAM_BOT_TOKEN`          | Mini App `initData` HMAC and the outbox drain (Bot API)                 |
| `TELEGRAM_OIDC_CLIENT_SECRET` | server-side OIDC code exchange (BotFather → Login Widget)               |

Plain variables: `APP_ENV`, `TELEGRAM_BOT_ID`, `TELEGRAM_ENVIRONMENT`, `TELEGRAM_OIDC_ENABLED`,
`TELEGRAM_OIDC_CLIENT_ID`, `WEB_PUBLIC_ORIGIN`, `ADMIN_PUBLIC_ORIGIN`, `CSRF_TRUSTED_ORIGINS`,
optional `LOG_LEVEL`, `APP_RELEASE`. Defaults for session TTLs, timeouts and limits match the
reference (`src/config.ts`).

## Commands

```bash
pnpm --filter @muniramarket/core-api-function test        # unit; integration needs TEST_DATABASE_URL
pnpm --filter @muniramarket/core-api-function typecheck
pnpm --filter @muniramarket/core-api-function build       # esbuild bundle check (dist/, git-ignored)
APP_ENV=development MM_APP_DATABASE_URL=postgresql://…local… SERVICE_AUTH_KEYS=… TELEGRAM_BOT_ID=0 \
  SESSION_COOKIE_SECURE=false CSRF_TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3001 \
  pnpm --filter @muniramarket/core-api-function dev        # http://127.0.0.1:8000
```

Integration tests: create a throw-away local database, migrate it with Alembic
(`make -C services/api migrate` with that database as `DATABASE_URL`), then
`TEST_DATABASE_URL=postgresql://…/that_db pnpm --filter @muniramarket/core-api-function test`.

Deploy: [infra/neon/README.md](../../infra/neon/README.md) (`neon config plan` first; it must show
only `coreapi`).
