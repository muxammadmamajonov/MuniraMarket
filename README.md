# MuniraMarket

MuniraMarket is an online grocery store for Tashkent. Customers browse the catalog, fill a cart
and order delivery either on a mobile-first website or inside a Telegram Mini App; both talk to
one Core API. Prices are in Uzbek so‘m, and the storefront is available in Uzbek and Russian.

Telegram is the primary identity: the server verifies every Telegram login, and the apps never
trust a Telegram user ID sent by the client.

## What is in this repository

| Part                         | Stack                      | Purpose                                                                 |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `apps/web`                   | Next.js, Tailwind CSS      | Storefront website and Telegram Mini App UI                             |
| `apps/admin`                 | Next.js                    | Catalog, delivery and order administration                              |
| `services/core-api-function` | Neon Function (Hono, `pg`) | Production Core API (`coreapi`): catalog, cart, checkout, orders, admin |
| `services/api-gateway`       | Cloudflare Worker          | Only entrance to the Function; Cron Trigger                             |
| `services/api`               | FastAPI, PostgreSQL        | Reference Core API, OpenAPI source, Alembic migrations                  |
| `services/telegram`          | Telegram Serverless        | Bot handlers and Mini App endpoints                                     |
| `packages/ui`                | React                      | Shared components, design tokens, so‘m format                           |
| `packages/contracts`         | TypeScript                 | API types generated from the OpenAPI document                           |

Design decisions are recorded in [architecture/](architecture/README.md).

## Run it locally

You need Node.js 24 with pnpm 12, Python 3.13 with [uv](https://docs.astral.sh/uv/), and Docker
for the local PostgreSQL.

```bash
pnpm install
cp infra/.env.example infra/.env            # choose a local-only password
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
```

Start the Core API with demo data:

```bash
cd services/api
cp .env.example .env                        # local placeholders; never commit .env
make install
make migrate                                # local database only
make seed                                   # synthetic demo catalog, zones and slots
cd ../..
# The production Core API code (Neon Function) on http://127.0.0.1:8000, with the same
# development settings (reads services/api/.env values from your shell):
set -a; . services/api/.env; set +a
pnpm --filter @muniramarket/core-api-function dev
# (the FastAPI reference still runs with `make -C services/api run` on the same port)
```

Start the storefront and the admin panel:

```bash
pnpm --filter @muniramarket/web dev         # http://localhost:3000
pnpm --filter @muniramarket/admin dev       # http://localhost:3001
```

Open `http://localhost:3000/uz` (or `/ru`) on a phone-sized window to see the storefront.

### Demo data

`make seed` fills a local database with a made-up Tashkent grocery catalog: about ten categories,
several dozen products with Uzbek and Russian names, prices in so‘m, kg/piece/litre units and a
mix of stock states, plus demo delivery zones and time slots. Every product is synthetic: SKUs
start with `DEMO-`, slugs with `demo-`, brand names are invented, and no product has an image,
so the storefront shows its placeholder. Real product images will be stored in object storage
later; the demo never links to external images.

The seed refuses to run unless `APP_ENV` is `development` or `test`, and running it twice
changes nothing.

### Demo catalog on a production or staging database

An operator can load the same synthetic catalog (without the seed's test-only edge cases) into a
deployed database whose catalog is still empty. Nothing does this automatically. You need:

- the database migrated to the latest revision (the usual migration job);
- the migration role's direct URL (`postgresql+asyncpg://…?ssl=verify-full`) from the secret
  store, in the `DEMO_IMPORT_DATABASE_URL` environment variable of your shell only. Paste it at
  the hidden prompt below so it stays out of your shell history and files.

Then, from `services/api` (after `make install`):

```bash
read -rs DEMO_IMPORT_DATABASE_URL && export DEMO_IMPORT_DATABASE_URL
uv run python -m app.ops.demo_catalog import --confirm "IMPORT DEMO CATALOG"
```

Without `--confirm` the command is a dry run that prints what it would create. It refuses to run
when the catalog already contains real (non-demo) categories or products. Running it again
changes nothing. The tool never prints the database URL.

- **Check:** `uv run python -m app.ops.demo_catalog status` counts demo and real rows.
- **Remove:** `uv run python -m app.ops.demo_catalog remove --confirm "REMOVE DEMO CATALOG"` (dry
  run without `--confirm`). It changes demo rows only. Demo products that orders reference are
  archived instead of deleted.
- **Delivery:** if the database has no delivery zones yet, the import adds zones named
  "Demo …"/"Демо …" with made-up fees and hours, and no time slots. They are placeholders.
  Replace them with the real delivery rules in the admin panel before taking real orders.

Run `unset DEMO_IMPORT_DATABASE_URL` when you are done.

## Tests and quality checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd services/api && make lint typecheck test build        # reference API + migrations
```

API integration tests run when `TEST_DATABASE_URL` points at a throw-away local database;
otherwise they are skipped.

The Playwright specs in `apps/web/e2e/` drive the built storefront and admin apps against a
seeded local Core API. Install the browser once with
`pnpm --filter @muniramarket/web exec playwright install chromium`, then run
`pnpm --filter @muniramarket/web test:e2e`. The comments in `apps/web/playwright.config.ts`
list the environment the specs expect; sign-in uses a throw-away Telegram bot token, and no
production code contains a test bypass.

After changing an API schema or route, run `pnpm contracts:generate` and commit the regenerated
contract files; CI fails when they are stale.

Every pull request runs these checks, a secret scan and the end-to-end tests.

## Security boundaries

- Never commit `.env` files, tokens, database URLs, customer data or catalog exports. Use the
  `.env.example` files, which contain placeholders only.
- Dev scripts and the dev seed run only against local development or test databases. The only
  demo data that may reach a deployed database is the operator-run demo catalog import above.
- Telegram identity is verified on the server; sessions use HTTP-only cookies with CSRF checks.
- Credentials, deployment settings and operational runbooks are kept outside this repository.
- Report security issues privately to the maintainers rather than in public issues.
