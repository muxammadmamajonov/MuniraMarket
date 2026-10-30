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
  models/            users, categories, products, carts, orders (money = integer UZS)
  domain/            pure business rules (order status transitions)
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
- **CSRF**: unsafe methods need a trusted `Origin` (or `Referer`) and, on authenticated routes,
  `X-CSRF-Token` equal to the `csrf_token` from the login / session response. Without either
  header, requests are refused in staging/production and allowed in development/test. Failure is
  `403 csrf_failed`.
- **Blocking**: the user is re-read on every authenticated request; blocked users get
  `403 account_blocked` and lose the session.
- **Rate limits** (fixed window, `mm:rl:<scope>:<subject>:<window_start>`): sign-in 10/min per IP,
  session lookup and logout 60/min per IP, cart reads 120/min and writes 60/min per user.
  `429 rate_limited` carries `Retry-After`.
- **Fail closed**: Redis errors on sessions or rate limits return `503 service_unavailable`.
- All `/api/v1/auth/*` responses and any response that sets the session cookie are
  `Cache-Control: no-store`. Tokens, CSRF tokens, hashes, cookies and `initData` are never logged.

### Client IP behind the proxy

Rate limits key on `request.client.host`. Behind the web proxy or a load balancer, run uvicorn with
`--proxy-headers --forwarded-allow-ips=<proxy address>` so that value is the real client; the
application never parses `X-Forwarded-For` itself. Do not use `--forwarded-allow-ips='*'` unless
the API is unreachable except through the proxy.

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

## Docker

```bash
docker build -t muniramarket-core-api services/api
```

The image is multi-stage, runs as a non-root user and carries no configuration; pass settings as
environment variables at runtime.
