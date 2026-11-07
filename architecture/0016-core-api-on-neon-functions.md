# ADR 0016 — Core API on Neon Functions (no Containers)

- Status: accepted
- Supersedes: the container parts of [0011](0011-cloudflare-neon-deployment.md); updates the
  trigger mechanics of [0015](0015-staff-group-and-notification-drain.md)
- Builds on: [0003](0003-service-auth-contract.md), [0007](0007-browser-sessions-csrf.md),
  [0008](0008-order-notification-outbox.md), [0013](0013-security-state-in-postgres.md),
  [0014](0014-telegram-oidc-browser-sign-in.md)

## Context

Production runs on the Cloudflare Workers **Free** plan: no Containers, Durable Objects or image
registry, and 10 ms of CPU per invocation. The FastAPI Core API ran in a Container behind a
Durable Object, so it cannot be deployed there, and no other compute (Koyeb, Redis, VMs) may be
added. The Neon project (`restless-shadow-93324151`, branch `production`, `aws-eu-central-1`)
offers Neon Functions: long-running Node.js 24 HTTP handlers next to the branch's Postgres, with
`DATABASE_URL` injected at runtime.

## Decision

```
Browser ─▶ Cloudflare web / admin Worker ─(service binding)─▶ API gateway Worker ─▶ Neon Function `coreapi` ─▶ Neon Postgres
Telegram Serverless ─▶ API gateway (public hostname, 2 signed routes) ─────────────┘
Cloudflare Cron Trigger ─▶ API gateway `scheduled()` (sign only) ───────────────────┘
```

- **Runtime.** The Core API is re-implemented in TypeScript (`services/core-api-function`, Hono +
  `pg`) as the Neon Function with the permanent slug `coreapi`. The FastAPI app stays in the
  repository as the behavioural reference, the OpenAPI source and the Alembic migration owner; it
  is not deployed. `packages/contracts/openapi.json` (generated from FastAPI, drift-checked in
  CI) is the contract; a test fails when the Function serves an operation set different from it.
- **Database.** One module-scope `pg` pool per isolate (`max: 5`) with `attachDatabasePool`.
  Runtime uses Neon's injected pooled `DATABASE_URL`; migrations stay on Alembic with the
  direct/unpooled migrator URL. Because the injected URL uses the branch's default role, every
  transaction starts with `SET LOCAL ROLE mm_app` (`DB_RUNTIME_ROLE`, required outside
  development) plus `SET LOCAL` statement/idle/lock timeouts, so the `mm_app` grants (DML only,
  append-only `audit_log`) still bound the API, and nothing leaks across pooled connections.
  Checkout, stock decrement, idempotency, slot reservation, status history and outbox enqueue are
  each one transaction with the reference's lock order.
- **Gateway ↔ Function.** The Function URL is a gateway **secret** (`CORE_API_FUNCTION_ORIGIN`),
  never shipped to a browser. The gateway adds `X-MM-Gateway-Secret: <CORE_API_FUNCTION_SECRET>`
  to every request; its header allow-list drops any caller copy first, so it cannot be spoofed.
  The Function compares it in constant time (SHA-256 digests + `timingSafeEqual`) before reading
  a body or touching Postgres and answers `401` otherwise, health checks included. The gateway
  builds the upstream URL from the fixed origin plus path and query, refuses redirects and maps
  timeouts to `504`.
- **Entrances unchanged.** Storefront and admin traffic still reaches the gateway only through
  service bindings (`StorefrontApi`, `AdminApi`); the public `api` hostname exposes only the health
  checks and the two signed routes Telegram Serverless calls (`internal/telegram/session`,
  `internal/telegram/staff-chat/connect`). `X-MM-Entrance`, `X-Forwarded-For` and `X-Request-ID`
  are still written by the gateway.
- **Cron.** The Cloudflare Cron Trigger stays (no Neon Function Trigger). Within 10 ms of CPU it
  only signs (ADR 0003, empty actor, `scheduler` key) and forwards
  `POST internal/scheduler/notifications/drain` every minute and `internal/maintenance/cleanup`
  every 15th minute. The Function drains the outbox next to Postgres with the same
  `drainOrderNotifications()` and Bot API transport as before; lease + `attempt` fencing keep it
  at-least-once and retry-safe, and an unreported message is reclaimed when its lease ends.
  `internal/scheduler/notifications/drain` is the one Function-only operation outside the
  FastAPI contract.
- **Security properties kept.** Cookie sessions with rotation and grace, CSRF (Origin + token),
  IDOR scoping, Postgres rate limits and replay nonces (ADR 0013), request ids, PII-redacting
  logs, `Cache-Control: no-store` on session-bound prefixes, body limits and the error envelope
  all behave as in the reference.

## Consequences

- No Docker image, registry, Durable Object or `CORE_API_IMAGE` anymore; the `Core API image`
  workflow and the container checks are gone. CI runs the Function's unit and integration tests
  against a PostgreSQL migrated by Alembic, and the Playwright suite against the Function code.
- Two implementations of the API live in the repository until the Python one is retired; behaviour
  changes must land in both, and the contract test catches route drift.
- The Function's native URL stays reachable from the internet; every request that lacks the
  gateway secret still costs a (cheap) Function invocation before it is rejected. Neon's
  account-wide concurrency cap (100) is not DDoS protection: volumetric filtering is Cloudflare's.
- Secrets are split by owner: the gateway holds only `CORE_API_FUNCTION_ORIGIN`,
  `CORE_API_FUNCTION_SECRET` and `SCHEDULER_SERVICE_SECRET`; the Function holds the Telegram, OIDC
  and service-auth secrets.
