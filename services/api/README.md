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

## Docker

```bash
docker build -t muniramarket-core-api services/api
```

The image is multi-stage, runs as a non-root user and carries no configuration; pass settings as
environment variables at runtime.
