# ADR 0001 — Monorepo layout and stack

- Status: accepted

## Decision

One repository, two toolchains:

| Path                 | Purpose                                           | Tooling                                                   |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `apps/web`           | Public website and Telegram Mini App UI           | Next.js (App Router), TypeScript strict, Tailwind         |
| `apps/admin`         | Admin panel (separate deployable, never indexed)  | Next.js, TypeScript strict                                |
| `packages/ui`        | Shared components, design tokens, UZS formatter   | TypeScript, React                                         |
| `packages/contracts` | Shared API types (users, order statuses, errors)  | TypeScript, no runtime deps                               |
| `services/api`       | Core e-commerce API: catalog, cart, orders, users | FastAPI, SQLAlchemy 2 (async), Alembic, PostgreSQL, Redis |
| `services/telegram`  | Telegram Serverless project (`tgcloud/`)          | Plain ESM JavaScript checked by `tsc --checkJs`, Vitest   |
| `infra`              | Local development services only                   | Docker Compose                                            |

- JavaScript workspaces use pnpm; Python uses uv with a committed lockfile.
- TypeScript is pinned to 6.0.x because typescript-eslint does not yet support 7.x.
- Web and admin are separate Next.js apps so admin code and dependencies never ship to customers
  and can be deployed behind separate access controls.
- `packages/contracts` mirrors the Core API schemas by hand for now. Generating it from the
  FastAPI OpenAPI document is a follow-up once the catalog endpoints exist.
- Every pull request runs format, lint, typecheck, unit tests and build for both toolchains, plus
  a secret scan.
