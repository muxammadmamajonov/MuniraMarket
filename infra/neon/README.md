# Neon PostgreSQL

Runbook for the production database. No connection string, host, project id or password belongs
in this repository. Design: [ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md),
[ADR 0013](../../architecture/0013-security-state-in-postgres.md),
[ADR 0016](../../architecture/0016-core-api-on-neon-functions.md) (the Core API runs as the
`coreapi` Neon Function on this branch).

## Core API Function (`coreapi`)

Project `restless-shadow-93324151`, branch `production`, `aws-eu-central-1`. Declared in
[`/neon.ts`](../../neon.ts), source `services/core-api-function`. The live branch also runs the
`catalog` and `hello` Functions, Neon Auth, the Data API, Realtime and two buckets; `neon.ts`
declares only `coreapi` (plus Auth and the Data API, so an apply never disables them).

```bash
# 1. A git-ignored env file with the Function's values (names: services/core-api-function/README.md)
# 2. Build the bundle neon.ts ships (bundler: 'none'):
pnpm --filter @muniramarket/core-api-function build
# 3. Dry run. It must list `+ function coreapi` (or `~ function coreapi`) and NOTHING else:
neon config plan --env <file>
# 4. Apply (creates or updates the coreapi deployment):
neon deploy --env <file>
neon functions get coreapi            # invocation_url -> gateway secret CORE_API_FUNCTION_ORIGIN
neon logs query --branch production --source function --since 15m
```

The Function connects **only** with the secret `MM_APP_DATABASE_URL`: the pooled endpoint (`-pooler`
host) as `mm_app` with its own password and `sslmode=require`. Neon may inject `DATABASE_URL` /
`DATABASE_URL_UNPOOLED` with the owner role; the Core API never reads them and `DATABASE_URL` is
never set by hand. One-time step per environment, as the project owner (`01-roles.sql` already
creates `mm_app` with a password you choose; never commit or paste it):

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v migrator_password="$MIGRATOR_PASSWORD" \
  -v app_password="$APP_PASSWORD" -f infra/neon/sql/01-roles.sql
# then build MM_APP_DATABASE_URL = postgresql://mm_app:<APP_PASSWORD>@<pooled host>/<db>?sslmode=require
# and put it only in the git-ignored --env file used by `neon deploy`.
```

The pool is created once per isolate (`max: 5`) and attached with `attachDatabasePool`.
Migrations never run in the Function: Alembic uses the direct (`DATABASE_URL_UNPOOLED`-style)
`mm_migrator` URL only.

## Project and branches

- **Exactly one Neon project: `munira-market`, production branch.** No staging project and no new
  project is created for launch. Sessions, rate-limit windows, replay nonces and OIDC login states
  live in this database too (ADR 0013); there is no Redis.
- Region: `aws-eu-central-1`, the same region as the `coreapi` Function (Functions run next to
  the branch's compute): every authenticated or rate-limited request writes to it. Measure p95
  latency through the gateway before launch (launch checklist).
- The production branch is **protected**; no developer connects to it from a laptop. The only
  extra branches are restore points (`pre-migration-<release>`), which nobody connects to except a
  restore.
- Migrations are rehearsed in CI (upgrade → downgrade → upgrade on a disposable PostgreSQL, plus
  the role model below) and locally, never on a copy of production data.
- Never create a branch of production for development or testing: it would copy customer data
  and live session hashes. Test data comes from `make seed` (synthetic) locally.
- The Neon **owner** password is break-glass only: it is never pulled into a `.env`, a Worker
  secret or CI. The runtime uses `mm_app`, migrations use `mm_migrator`.

## Roles (least privilege)

| Role                    | Created by               | Used by                                       | Rights                                                                               |
| ----------------------- | ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| project owner (Console) | Neon                     | break-glass only, MFA operator                | `neon_superuser`                                                                     |
| `mm_migrator`           | `sql/01-roles.sql` (SQL) | one-off migration job only                    | owns the schema objects; `CONNECTION LIMIT 3`                                        |
| `mm_app`                | `sql/01-roles.sql` (SQL) | the Core API Function (`MM_APP_DATABASE_URL`) | DML on app tables (incl. security state); `audit_log`: `SELECT, INSERT` only; no DDL |

Roles are created with SQL so they are **not** members of `neon_superuser` (Console/API-created
roles are). Setup, once per environment, as the project owner:

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v migrator_password="$MIGRATOR_PASSWORD" \
  -v app_password="$APP_PASSWORD" -f infra/neon/sql/01-roles.sql
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/02-database.sql
psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/03-default-privileges.sql
```

If revisions 0001–0004 were applied before the role model was installed, their public-schema
objects are still owned by the Neon owner. Before running the next migration as `mm_migrator`,
run the narrowly allow-listed, one-time adoption script as that owner:

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
  -f infra/neon/sql/00-adopt-legacy-public-schema.sql
```

It refuses unexpected tables, missing known application tables, unknown enum types and sequences;
it never touches Neon Auth, Data API or another schema.

After **every** migration, as `mm_migrator`:

```bash
psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/10-runtime-grants.sql
psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/20-verify-runtime-role.sql
```

`scripts/verify-roles.sh` runs the whole model against a disposable PostgreSQL in CI and proves
that `mm_app` cannot `UPDATE`, `DELETE` or `TRUNCATE` `audit_log`, alter tables, drop triggers or
read `alembic_version`.

## Connection strings

- Runtime (`MM_APP_DATABASE_URL`, Neon Function secret):
  `postgresql://mm_app:<password>@<pooled -pooler host>/<db>?sslmode=require`. Transaction-mode
  pooling suits it: every guard is `SET LOCAL` and no session state is used. `mm_app` cannot
  `SET ROLE`/`SET SESSION AUTHORIZATION` to any other role (verified in CI).
- Injected `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (owner role): unused by the Core API.
- Migrations (`MIGRATION_DATABASE_URL`, GitHub Environment secret): the **direct/unpooled**
  endpoint, `mm_migrator`, `postgresql+asyncpg://…?ssl=verify-full` (Alembic, asyncpg).
- Workers never connect directly; they reach data only through the gateway and the Function.

## Pool limits

Per Function isolate: `pg` pool `max: 5` (module scope, reused by every request on the isolate),
`statement_timeout` 15 s, `idle_in_transaction_session_timeout` 30 s, `lock_timeout` 5 s, all
`SET LOCAL` per transaction. Total connections scale with live isolates; Neon's pooler absorbs
them (transaction mode, which is why every guard is transaction-local and no session state is
used). Keep `mm_app`'s `CONNECTION LIMIT` above isolates x 5. Keep `mm_migrator` at
`CONNECTION LIMIT 3`.

## Backups, restore drill, rollback

Neon keeps a restore window (history retention) per project; set it to the longest your plan
allows for production and confirm it in the console. Point-in-time restore creates a branch at a
timestamp; promoting it (or pointing `MM_APP_DATABASE_URL` at it) is the restore.

**Before every production migration**

- [ ] Note the UTC time and create a branch `pre-migration-<release>` from production `main`.
- [ ] The release's migrations passed CI (upgrade / downgrade / upgrade, role model) without errors.
- [ ] Migrations are backward compatible with the release currently running (expand first;
      drop/rename only in a later release).
- [ ] Run the job, then `10-runtime-grants.sql` and `20-verify-runtime-role.sql`.

**Migration rollback**

- Preferred: a forward fix (new migration).
- If the schema change itself is the problem and no data was written in the new shape:
  `alembic downgrade -1` on a rehearsal branch first, then production, then redeploy the previous
  Function code.
- If data is damaged: restore from `pre-migration-<release>` (or a point in time), promote it,
  redeploy the matching Function code. Orders written after the restore point must be
  reconciled by hand from the audit log and logs; write that down in the incident.

**Restore drill (before launch, then quarterly)**

- [ ] Create a branch from production at "now minus 1 hour" (before launch: from the empty,
      freshly migrated production branch).
- [ ] Point a local Core API at it (`pnpm --filter @muniramarket/core-api-function dev`,
      `APP_ENV=development`, temporary `mm_app` URL, never committed),
      check readiness, count orders/products, then remove the URL.
- [ ] Record time-to-restore and any manual step; delete the branch afterwards.
- [ ] Confirm no restored data left the Neon project (no dumps on laptops).

**Logical backup** (optional, in addition to Neon's history): a scheduled `pg_dump` by a
dedicated read-only role to encrypted storage owned by the business, retained per the privacy
policy. Not set up yet; decide before collecting real orders at scale.
