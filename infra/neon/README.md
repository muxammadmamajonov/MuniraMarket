# Neon PostgreSQL

Runbook for the staging and production databases. No connection string, host, project id or
password belongs in this repository. Design: [ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md).

## Projects and branches

- **One Neon project per environment**: `staging` and `production`. Separate projects mean
  separate credentials and that no staging (or preview) build can ever reach production data.
- Region: close to the Cloudflare location that runs the containers (Europe for Uzbekistan
  traffic); keep Redis in the same region. Measure p95 latency from a staging container before
  launch (launch checklist).
- Production project: the default branch is **protected**; no developer connects to it from a
  laptop. Staging project: the default branch is the staging database; short-lived child branches
  are used to rehearse migrations (`rehearse-<release>`), then deleted.
- Never create a branch of production for development or testing: it would copy customer data.
  Test data comes from `make seed` (synthetic) in staging and locally.

## Roles (least privilege)

| Role                    | Created by               | Used by                        | Rights                                                        |
| ----------------------- | ------------------------ | ------------------------------ | ------------------------------------------------------------- |
| project owner (Console) | Neon                     | break-glass only, MFA operator | `neon_superuser`                                              |
| `mm_migrator`           | `sql/01-roles.sql` (SQL) | one-off migration job only     | owns the schema objects; `CONNECTION LIMIT 3`                 |
| `mm_app`                | `sql/01-roles.sql` (SQL) | the Core API container         | DML on app tables; `audit_log`: `SELECT, INSERT` only; no DDL |

Roles are created with SQL so they are **not** members of `neon_superuser` (Console/API-created
roles are). Setup, once per environment, as the project owner:

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v migrator_password="$MIGRATOR_PASSWORD" \
  -v app_password="$APP_PASSWORD" -f infra/neon/sql/01-roles.sql
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/02-database.sql
```

After **every** migration, as `mm_migrator`:

```bash
psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/10-runtime-grants.sql
psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/20-verify-runtime-role.sql
```

`scripts/verify-roles.sh` runs the whole model against a disposable PostgreSQL in CI and proves
that `mm_app` cannot `UPDATE`, `DELETE` or `TRUNCATE` `audit_log`, alter tables, drop triggers or
read `alembic_version`.

## Connection strings

- Runtime (`DATABASE_URL`, gateway Worker secret): `postgresql+asyncpg://mm_app:<password>@<direct
endpoint host>/<db>?ssl=require`. Use the **direct** (non-pooled) endpoint: the API keeps its own
  small pool and uses prepared statements, which a transaction-mode pooler does not suit. The API
  refuses to start in staging/production without `ssl=require` (or `verify-ca`/`verify-full`) and
  refuses libpq's `sslmode=` everywhere (asyncpg would reject it at connect time).
- Migrations (`MIGRATION_DATABASE_URL`, GitHub Environment secret): same host, `mm_migrator`.
- Workers never connect directly. If one ever needs the database, put **Hyperdrive** in front of
  it with a dedicated read-only role.

## Pool limits

Per container: `DB_POOL_SIZE=5`, `DB_MAX_OVERFLOW=5` (max 10 connections), `DB_POOL_TIMEOUT_SECONDS=10`,
`statement_timeout` 15 s, `idle_in_transaction_session_timeout` 30 s, `lock_timeout` 5 s (role
default). Budget:

```
instances x (pool + overflow)  =  3 x 10 = 30  (production; staging 2 x 10 = 20)
+ rollout overlap (old + new)  ->  up to 60     = mm_app CONNECTION LIMIT
+ migration job                    3            = mm_migrator CONNECTION LIMIT
```

Keep the total well under the compute size's `max_connections` (check the Neon compute you pick).
Raise `CONTAINER_INSTANCES` and the role's `CONNECTION LIMIT` together.

## Backups, restore drill, rollback

Neon keeps a restore window (history retention) per project; set it to the longest your plan
allows for production and confirm it in the console. Point-in-time restore creates a branch at a
timestamp; promoting it (or pointing `DATABASE_URL` at it) is the restore.

**Before every production migration**

- [ ] Note the UTC time and create a branch `pre-migration-<release>` from production `main`.
- [ ] The release's migrations ran on staging (and on a `rehearse-<release>` branch) without errors,
      including `alembic downgrade -1` and `upgrade head` again on the rehearsal branch.
- [ ] Migrations are backward compatible with the release currently running (expand first;
      drop/rename only in a later release).
- [ ] Run the job, then `10-runtime-grants.sql` and `20-verify-runtime-role.sql`.

**Migration rollback**

- Preferred: a forward fix (new migration).
- If the schema change itself is the problem and no data was written in the new shape:
  `alembic downgrade -1` on a rehearsal branch first, then production, then redeploy the previous
  image digest.
- If data is damaged: restore from `pre-migration-<release>` (or a point in time), switch
  `DATABASE_URL`, redeploy the matching image. Orders written after the restore point must be
  reconciled by hand from the audit log and logs; write that down in the incident.

**Restore drill (before launch, then quarterly)**

- [ ] Create a branch from production at "now minus 1 hour" (or from staging before launch).
- [ ] Point a staging gateway at it (temporary secret), run the smoke test, count orders/products.
- [ ] Record time-to-restore and any manual step; delete the branch afterwards.
- [ ] Confirm no restored data left the Neon project (no dumps on laptops).

**Logical backup** (optional, in addition to Neon's history): a scheduled `pg_dump` by a
dedicated read-only role to encrypted storage owned by the business, retained per the privacy
policy. Not set up yet; decide before collecting real orders at scale.
