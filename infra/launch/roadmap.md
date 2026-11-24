# Canonical roadmap (P0 / P1 / P2)

One list, replacing the scattered P0/P1 notes. Details of each P1 item stay in
`infra/launch/p1-handoff.md`; the compute rules in `infra/launch/low-compute-working-plan.md`.
Nothing here was deployed, and no SQL was run against any database.

## P0: closed

Committed in `cefd503`: native pinch-zoom (WCAG 1.4.4), admin background refresh and new-order
badge, confirmations before out-of-stock and DELIVERED, mandatory `expected_status` on order
status changes (API, Core API, contracts), `robots.txt`, page titles and `noindex` on private
pages, docs cleanup. Afterwards: admin `error.tsx` and `not-found.tsx` (an unreachable Core API or
an unknown URL no longer ends on a bare framework page).

## P1: open (gate in `p1-handoff.md` is not ticked)

| Item                                            | State                                                    | Blocked by                         |
| ----------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| T1, U2, U3, U4, U5                              | Closed                                                   | none                               |
| D1 expand-then-contract                         | Prepared in code and docs                                | a person accepts ADR 0019          |
| S2 revoke DELETE on orders                      | SQL prepared, not run                                    | database: branch run, then prod    |
| P1 cart-read round-trips                        | Not done (security/session core)                         | approval, test database            |
| O4 staging isolation                            | Config + docs; fail-closed check not done                | decision (gateway-to-Function)     |
| O5 inventory / PUBLIC grants                    | SQL prepared, not run                                    | database: someone runs and reports |
| O6 WAF, rate limits, alerts                     | Rules documented                                         | Cloudflare dashboard access        |
| O7 backups and restore drill                    | Runbook written                                          | storage, read-only role, job owner |
| Neon `anonymous`/`authenticated` grants cleanup | `cleanup-authenticated-grants.sql` at repo root, not run | database (see below)               |

## User-only handoffs

Every open P1 row above needs a person (database, Cloudflare dashboard, a decision or an approval);
none can be finished from the repository. Steps and acceptance checks: `p1-handoff.md`.

## P2: not started

Do not start until the P1 gate is ticked. Only record candidates here; none are implemented.

## Database handoff (paused on purpose)

Database cleanup is stopped. Whoever resumes it, in this order, on a Neon **branch first**:

1. Run the O5 queries (read-only) and review the results.
2. Dry-run `infra/neon/review/s2-revoke-delete-order-history.sql` (STEP 1 ends in `ROLLBACK`).
3. Review `cleanup-authenticated-grants.sql` (run as `mm_migrator`; verification block aborts and
   rolls back on leftovers). It does not touch managed Neon roles, membership or RLS.
4. Run the integration suite against the branch with `TEST_DATABASE_URL`, then production.

Out of scope until a person decides: RLS (`infra/neon/rls-review.md`), checkout locking, the
security/session core, any new migration.

## Next best step

A person ticks the P1 gate: accept ADR 0019 (D1), decide O4, then run the database items on a
branch. P2 only afterwards.
