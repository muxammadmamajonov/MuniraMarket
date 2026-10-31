# ADR 0011 — Cloudflare Workers + Containers, Neon, managed Redis, R2

- Status: accepted

## Context

MuniraMarket goes to a soft launch. The storefront/Mini App and the admin are Next.js apps, the
Core API is FastAPI in a Docker image, data is PostgreSQL, sessions and rate limits are Redis.
We want edge delivery for the frontends, no servers to patch, separate environments, and no
weakening of the existing session, CSRF, service-auth, rate-limit or CSP protections.

## Decision

**Topology** (`infra/README.md` has the diagram):

```
browser / Telegram ──https──> muniramarket-web   (Worker, vinext) ──service binding──┐
staff browser ─────https──> muniramarket-admin  (Worker, vinext) ──service binding──┤
Telegram Serverless ─https─> muniramarket-api-gateway (Worker, public: health + internal/telegram)
                                                   │ StorefrontApi / AdminApi entrypoints
                                                   ▼
                              CoreApiContainer (Durable Object) ──> FastAPI container (:8000)
                                                   │ TLS                      │ TLS
                                                   ▼                          ▼
                                       Neon PostgreSQL (mm_app)        managed Redis (rediss://)
```

- **Frontends on Workers, not Pages**, built with **vinext** (Next.js API on Vite + the Cloudflare
  Vite plugin). The migration is additive: `next dev/build/start`, the unit tests and Playwright
  E2E are unchanged; `vite.config.ts` / `cloudflare.config.ts` only drive the Workers build.
  Configuration uses the `cf` CLI and typed `cloudflare.config.ts` (the current Cloudflare default
  for new projects); `--mode staging|production` selects the environment.
- **Core API stays FastAPI in its existing image**, run by Cloudflare Containers (Durable Object
  scheduling, a fixed pool of interchangeable instances, `basic` class by default). It is not
  ported to the Workers runtime or D1. The container's **only ingress is its Durable Object**,
  inside the `muniramarket-api-gateway` Worker.
- **Three entrances, three allow-lists.** The gateway's public hostname serves only liveness,
  readiness and the service-signed `internal/telegram/**` routes (ADR 0003). The storefront and
  admin reach the API through **service bindings** to the `StorefrontApi` / `AdminApi`
  entrypoints, which have no public route; each enforces the same path rules as the app proxy
  in front of it (storefront: never `admin/**` or `internal/**`; admin: `admin/**` and the Login
  Widget/session routes only). Browsers still only talk to their own origin (`connect-src
'self'`), so session cookies stay first-party and CSRF rules are unchanged.
- **Client IP.** Cloudflare sets `CF-Connecting-IP`; the app proxies forward it as
  `X-Forwarded-For` (`CLIENT_IP_HEADER=cf-connecting-ip`), the gateway validates it is one IP and
  **always rewrites** `X-Forwarded-For` (public entrance: from `CF-Connecting-IP`). uvicorn trusts
  `X-Forwarded-For` only from `FORWARDED_ALLOW_IPS`; because nothing but the gateway can reach the
  container, that list is the private ranges the platform proxy connects from (narrow it to the
  observed peer after the first staging deploy). `*` stays forbidden.
- **Neon PostgreSQL** is the only database; **no D1, no KV** for application state. Staging and
  production are **separate Neon projects** (separate credentials, no branch of production data
  in staging); local development uses Docker PostgreSQL. Roles are created with SQL so they are
  not `neon_superuser`: `mm_migrator` owns the schema and is used only by the one-off migration
  job (`MIGRATION_DATABASE_URL`); `mm_app` is the runtime role with DML only and
  `SELECT, INSERT` on `audit_log` (completing the deployment item of ADR 0010). TLS is mandatory
  (`ssl=require`; the API refuses to start otherwise), pools are bounded per process and capped
  per role. Workers do not talk to the database today; if one ever must, it goes through
  **Hyperdrive**, never a direct connection.
- **Managed Redis over TLS** (`rediss://`) for sessions, rate limits and replay nonces, one
  instance (or at least one database with its own ACL user) per environment, `noeviction`.
- **R2 for product images**, foundation only: upload rules, content-addressed keys, checksums,
  storage interface and test doubles. No bucket, credential or upload exists yet. Browsers never
  get bucket credentials; uploads go through the Core API (or, later, a short-lived pre-signed
  `PUT` for one exact key). The admin CSP keeps `img-src 'self' data:` and the admin shows a
  placeholder until the image CDN hostname is deliberately allow-listed.
- **Releases are immutable.** The API image is built once per commit (`sha-<12 hex>`), pushed to
  Cloudflare's registry and deployed **by digest** (`CORE_API_IMAGE=...@sha256:...`); the same
  digest is promoted from staging to production. Durable Object-scheduled Containers only start
  digest-pinned images from `registry.cloudflare.com`.
- **Observability.** Workers Logs and Traces are on (query strings redacted, traces sampled at
  10% in production); the API writes one JSON object per line with a request id that the gateway
  propagates (`X-Request-ID`), and never logs IPs, cookies, tokens, addresses, phone numbers,
  `initData` or database URLs.
- **Secrets** live only as Worker secrets on the gateway (`DATABASE_URL`, `REDIS_URL`,
  `SERVICE_AUTH_KEYS`, `TELEGRAM_BOT_TOKEN`), passed into the container at start, and in the
  GitHub `production`/`staging` environments for the migration job and image push. Nothing secret
  is in the repository; deploy-time hostnames and ids come from `MM_*` variables.

## Consequences

- One extra hop (Worker → Durable Object → container) per API call; service bindings keep it on
  Cloudflare's network. Cold starts of a sleeping container are absorbed by a readiness loop
  (up to ~30 s) and by a long inactivity timeout in production (2 h).
- `cf` and the Cloudflare Vite plugin are beta; versions are pinned and the Workers builds,
  binding types and a Workers-runtime header check run in CI, so an upgrade that breaks them
  fails the pull request.
- vinext has no build-time image optimisation and does not wrap the App Router in StrictMode;
  neither is used by the apps today. CDN/data caching is off (`vinext init --cdn-cache=none
--data-cache=none`): every page renders per request, which is correct for session-bound pages
  and acceptable for the catalog at launch scale. Revisit with Workers Cache for public catalog
  pages only.
- Container instances are a fixed pool chosen at random (no autoscaling yet). Capacity is raised
  by `CONTAINER_INSTANCES` together with the Neon role's `CONNECTION LIMIT`.
