# ADR 0019 — Expand-then-contract migrations and the readiness schema check

- Status: accepted (policy and checks; no migration is created by this ADR)
- Builds on: [0011](0011-cloudflare-neon-deployment.md), [0013](0013-security-state-in-postgres.md),
  [0016](0016-core-api-on-neon-functions.md)

## Context

The documented release order is: migrate the database, then deploy the new Function. For the
length of that gap the **old** Function runs against the **new** schema. Revisions 0007 (dropped
delivery columns and three tables) and 0009 (replaced check constraints) were destructive, so the
old Function broke between the two steps. There is one Neon project and no staging database, so
nothing rehearses this.

## Decision

1. **Two releases for anything destructive.**
   - _Expand_ release: additive only (new nullable column, new table, new index, a wider
     constraint). The old and the new Function both work. Deploy the Function that stops using the
     old thing.
   - _Contract_ release (a later release, after the new Function has served traffic): drop the
     column or table, tighten the constraint, make a column `NOT NULL`.
2. **A contract revision carries a marker line** in its file, `# contract: <what the previous
release already stopped using>`. A unit test (`services/core-api-function/test/unit/
migration-policy.test.ts`) fails for any revision after 0009 whose `upgrade()` drops, alters,
   truncates or deletes without the marker. 0001-0009 are grandfathered.
3. **The Function is unready when the schema is behind it.** `/health/ready` probes the objects
   this release reads (`src/readiness.ts`, `LIMIT 0` queries). The runtime role cannot read
   `alembic_version`, so the probes are the "expected revision". Add a probe in the same change as
   any code that reads a new table or column. A passing result is cached for 10 s in the isolate,
   so the public endpoint cannot be used to load the database.
4. **Deploy order.** migrate -> `10-runtime-grants.sql` -> `20-verify-runtime-role.sql` -> deploy
   Function -> check `/health/ready`. Roll back by redeploying the previous Function; never
   `downgrade` a contract revision on production.

## What this does not cover

The probes catch a Function that runs _ahead_ of the schema. They cannot catch a schema that moved
ahead of an older Function; only rule 1 prevents that. Revisions 0007 and 0009 are already applied:
nothing to undo, but a rollback past 0009 would need the Function from before it.

## Consequences

A column removal takes two releases and a few days. In exchange a deploy no longer has a window
where signed-in requests fail, and a missed migration shows as an unready Function, not as 500s.
