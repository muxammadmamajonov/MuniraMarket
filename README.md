# MuniraMarket

E-commerce platform for MuniraMarket: a mobile-first website and a Telegram Mini App backed by one
Core API.

The repository contains application source code and safe development configuration only.
Credentials, operational material, and internal product documentation are intentionally excluded
from version control.

## Layout

```
apps/
  web/          Next.js — public website + Telegram Mini App UI
  admin/        Next.js — admin panel
services/
  api/          FastAPI Core API (PostgreSQL, Redis)
  telegram/     Telegram Serverless project (handlers, Mini App endpoints)
packages/
  ui/           shared UI components, design tokens, UZS formatter
  contracts/    shared API types
infra/          local development services (Docker Compose)
architecture/   decision records
```

See [architecture/](architecture/README.md) for the decisions behind this structure.

## Requirements

- Node.js 24 (`.nvmrc`) and pnpm 12
- Python 3.13 and [uv](https://docs.astral.sh/uv/)
- Docker (for local PostgreSQL and Redis)

## Getting started

```bash
pnpm install
cp infra/.env.example infra/.env            # set a local-only password
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
```

Core API:

```bash
cd services/api
cp .env.example .env                        # local placeholders; never commit .env
make install
make migrate                                # local database only
make run                                    # http://localhost:8000/api/v1/health
```

Web and admin:

```bash
pnpm --filter @muniramarket/web dev         # http://localhost:3000
pnpm --filter @muniramarket/admin dev       # http://localhost:3001
```

The Telegram Serverless project is deployed with the `tgcloud` CLI by an operator who holds the
bot's credentials; see [services/telegram/README.md](services/telegram/README.md).

## Quality checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd services/api && make lint typecheck test build
```

The same checks, plus a secret scan, a contracts drift check and the Playwright E2E (storefront
and admin), run on every pull request.

### E2E (Playwright)

The specs in `apps/web/e2e/` drive the built storefront and admin apps against a seeded Core API;
CI wires all of it up in the `e2e` job of `.github/workflows/ci.yml`. To run them locally:

1. Start the Core API against a throw-away database with `APP_ENV=development`, a throw-away
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_LOGIN_WIDGET_ENABLED=true`, a `TELEGRAM_BOT_USERNAME` and
   `CSRF_TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3001`; run `make migrate seed`.
2. Create the E2E admin: `cd services/api && uv run python -m app.dev.set_role 990000001 admin --create`.
3. Build and start both apps: `pnpm --filter @muniramarket/web build`, then `... start` (web on
   port 3000), and the same for `@muniramarket/admin` (port 3001).
4. Run `pnpm --filter @muniramarket/web exec playwright install chromium`, then with
   `E2E_TELEGRAM_BOT_TOKEN` (the same throw-away token), `E2E_ADMIN_TELEGRAM_ID=990000001` and
   optionally `E2E_BASE_URL` / `E2E_ADMIN_URL`: `pnpm --filter @muniramarket/web test:e2e`.

The admin specs sign in through the Telegram Login Widget redirect with fields signed by the
throw-away token; no production code has a test bypass. See the comment in
`apps/web/playwright.config.ts` for details.

`packages/contracts` is generated from the Core API's OpenAPI document. After changing an API
schema or route, run `pnpm contracts:generate` and commit `packages/contracts/openapi.json` and
`packages/contracts/src/generated/openapi.ts`; CI fails when they are stale.

## Security

- Never commit `.env` files, tokens, database URLs with real credentials, customer data or
  catalog exports. Use `.env.example` with placeholders.
- Telegram identity is verified on the server; client-supplied Telegram user IDs are never trusted.
- Report security issues privately to the maintainers rather than in public issues.
