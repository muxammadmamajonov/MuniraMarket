# ADR 0002 — Telegram Serverless vs. Core API boundary

- Status: accepted

## Context

Telegram bot logic runs on Telegram Serverless (BotFather → Serverless, `tgcloud` CLI). There is no
aiogram, no long polling and no self-hosted webhook server. The platform runs plain JavaScript
modules in a V8 isolate with only its `sdk` (`db`, `api`, `fetch`) and the project's own modules.
Handlers react to Telegram update types; endpoints are called by the Mini App through
`Telegram.WebApp.Serverless.call`, and the platform verifies `initData` before the endpoint runs.

## Decision

- **Serverless owns Telegram-facing glue only:** update handlers (`/start`, menu entry to the Main
  Mini App), Mini App endpoints that need the platform-verified user, and formatting/sending of
  Telegram messages.
- **Core API owns the business:** users, catalog, carts, orders, inventory, payments and audit live
  in PostgreSQL behind FastAPI. The Serverless database holds only service configuration.
- Serverless calls Core API over HTTPS with signed requests (ADR 0003). The acting Telegram user is
  taken from platform-verified data (`ctx.initData.user`, `message.from`), never from endpoint input.
- The website and future mobile apps talk to Core API directly; they do not depend on Serverless.
- Business logic in `services/telegram` sits in `tgcloud/lib/` behind injected dependencies so it is
  unit-tested locally; handler/endpoint files are thin wrappers.

## Consequences

- If Serverless limits or availability change, only the Telegram channel is affected.
- Deployment (`tgcloud push`/`migrate`), the CLI token, the Main Mini App URL and the service secret
  are provisioned by an operator; none of them are in this repository.
- Mini App front-end hosting (Serverless static hosting at `app<id>.tgcloud.ai` vs. our own domain)
  is not decided yet. Serverless static hosting requires a static export, which conflicts with
  server-rendered public pages; the decision is deferred to the catalog phase.
