# MuniraMarket

MuniraMarket is an online grocery store for Tashkent. Customers browse the catalog, fill a cart
and order delivery either on a mobile-first website or inside a Telegram Mini App; both talk to
one Core API. Prices are in Uzbek so‘m, and the storefront is available in Uzbek and Russian.

Telegram is the primary identity: the server verifies every Telegram login, and the apps never
trust a Telegram user ID sent by the client.

## What is in this repository

| Part                 | Stack                      | Purpose                                       |
| -------------------- | -------------------------- | --------------------------------------------- |
| `apps/web`           | Next.js, Tailwind CSS      | Storefront website and Telegram Mini App UI   |
| `apps/admin`         | Next.js                    | Catalog, delivery and order administration    |
| `services/api`       | FastAPI, PostgreSQL, Redis | Core API: catalog, cart, checkout, orders     |
| `services/telegram`  | Telegram Serverless        | Bot handlers and Mini App endpoints           |
| `packages/ui`        | React                      | Shared components, design tokens, so‘m format |
| `packages/contracts` | TypeScript                 | API types generated from the OpenAPI document |

Design decisions are recorded in [architecture/](architecture/README.md).

## Run it locally

You need Node.js 24 with pnpm 12, Python 3.13 with [uv](https://docs.astral.sh/uv/), and Docker
for the local PostgreSQL and Redis.

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
make run                                    # http://localhost:8000/api/v1/health
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

## Tests and quality checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd services/api && make lint typecheck test build
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
- Demo data and dev scripts run only against local development or test databases.
- Telegram identity is verified on the server; sessions use HTTP-only cookies with CSRF checks.
- Credentials, deployment settings and operational runbooks are kept outside this repository.
- Report security issues privately to the maintainers rather than in public issues.
