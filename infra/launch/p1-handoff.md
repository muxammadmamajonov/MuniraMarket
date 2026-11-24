# P1 handoff: what is closed, what needs a person

Updated after the second pass. Nothing was committed, pushed, deployed or run against a database;
every SQL file is for review and for the Neon SQL Editor on a **branch first**.

## Verdict

**P1 is not closed.** Every item below that is marked _prepared_ still needs a person to run or
approve something outside the repository. Do not start P2 until the gate at the bottom is ticked.

| Item | State                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | Closed (contract request-shape tests).                                                                                                 |
| U2   | Closed (page titles).                                                                                                                  |
| U3   | Closed (description, canonical, `hreflang`, OpenGraph). Optional deploy setting `SITE_ORIGIN`.                                         |
| U4   | Closed (`robots.txt` and `sitemap.xml`).                                                                                               |
| U5   | Closed (single product fetch).                                                                                                         |
| D1   | **Prepared, in code and docs:** ADR 0019, readiness schema probes, migration-policy test. Needs a person to accept the policy (below). |
| S2   | **Prepared, SQL only:** `infra/neon/review/s2-revoke-delete-order-history.sql`. Needs a person to run it on a branch, then production. |
| P1   | Open. Security/session code; not touched (needs approval).                                                                             |
| O4   | **Prepared, in config and docs:** staging validation + acceptance checks. The fail-closed Function check is a design decision (below). |
| O5   | **Prepared, SQL only:** `infra/neon/review/o5-inventory-and-public-privileges.sql`. Needs a person to run it and send the results.     |
| O6   | **Prepared, docs:** `infra/launch/o6-cloudflare-rules.md` (rule parameters). Needs Cloudflare dashboard access.                        |
| O7   | **Prepared, docs:** `infra/neon/backup-restore-runbook.md`. Needs storage, a read-only role and a job owner.                           |

Also prepared (not on the P1 list): RLS inventory and design (`infra/neon/rls-review.md`,
`infra/neon/review/rls-preflight.sql`, nothing enabled) and a low-compute working plan
(`infra/launch/low-compute-working-plan.md`). The compute allowance itself cannot be changed from
here.

## D1: expand-then-contract and the readiness check

- **Done:** `architecture/0019-expand-then-contract-migrations.md`; `/health/ready` now also probes
  the objects added by 0007-0009 and answers from a 10 s success cache
  (`services/core-api-function/src/readiness.ts`); a unit test fails any revision after 0009 that
  drops or tightens something without a `# contract:` marker.
- **You do:** read ADR 0019 and accept (or change) the policy; add a line to the release checklist
  that the deploy order is migrate, grants, verify, Function, `/health/ready`.
- **Acceptance:** `pnpm --filter @muniramarket/core-api-function test` passes; on a Neon branch
  migrated to 0008 only, the new Function's `/health/ready` is `503` (and `200` after 0009).
- **Risk:** the probes catch a Function ahead of the schema, not a schema ahead of an older
  Function; only the two-release rule prevents that. 0007 and 0009 are already applied and stay
  grandfathered. No migration was created.

## S2: revoke DELETE on `orders`, `order_items`, `order_status_history` from `mm_app`

- **Evidence:** nothing in `services/core-api-function/src` deletes those three tables (the only
  deletes are `auth_sessions`, `oidc_login_states`, `user_addresses`, `cart_items`, `categories`,
  `rate_limit_counters`, `service_request_nonces`). Cascades run as the table owner. Tables and the
  role name were checked against migrations 0001-0009 and `infra/neon/sql/*.sql`.
- **You do:** follow `infra/neon/review/README.md`: branch first, STEP 0, STEP 1 (dry run, ends in
  `ROLLBACK`), STEP 2, STEP 3. The SQL Editor role may not be allowed to revoke what
  `mm_migrator` granted: the file says what to do then (`psql` with the migrator URL).
- **Then:** run the integration suite against the branch (`TEST_DATABASE_URL`), and only then
  production. After production is verified, fold the two lines in the file's "MAKE IT STICK"
  section into `10-runtime-grants.sql` and `20-verify-runtime-role.sql`, or the next migration
  puts DELETE back.
- **Acceptance:** STEP 3 shows `delete_allowed = false` for all three tables and `true` for
  select/insert/update; checkout, cancel and admin order flows pass on the branch.
- **Risk:** low, if the search above is right; a hidden delete path would fail with
  `permission denied`. Rollback is one `GRANT` (in the file).

## P1 (cart read round-trips): not done

- **Why:** the fix changes how session and rate-limit queries share a transaction
  (`security/session.ts`, `security/rateLimit.ts`, `db.ts`): security core.
- **You do:** approve the change; ensure a test database is available.
- **Acceptance:** about 17 round-trips per authenticated cart read drop well below that with
  identical session, CSRF and rate-limit behaviour (existing security tests unchanged).
- **Risk:** weakening a session or rate-limit guarantee.

## O4: staging must not reach production data

- **Done:** `validate-deploy-env.mts --mode staging` refuses `MM_CORE_API_FUNCTION_HOST` equal to
  `MM_PRODUCTION_FUNCTION_HOST` (tested); `infra/README.md` no longer claims a guarantee and lists
  the acceptance checks; `deploy-env.example` has the new variables.
- **Decision for you:** also make the Function refuse a gateway from another environment (gateway
  sends `APP_ENV`, Function compares with its own). That is the only fail-closed fix, and it edits
  the gateway-to-Function authentication, so it was not done. Until then, do not create staging
  against the production Neon project.
- **Acceptance:** see the checklist in `infra/README.md`.
- **Risk:** the validator checks what the operator declares, not the secret itself.

## O5: inventory and PUBLIC privilege audit

- **You do:** run the 15 queries in `infra/neon/review/o5-inventory-and-public-privileges.sql` one
  at a time on a branch (read-only), send the results. Nothing is revoked.
- **Look for:** schemas other than `public` (neon_auth, the Data API schema), grants to `PUBLIC`,
  `anon`, `authenticated` (query 8), publications (13), unexpected triggers and functions.
- **Risk:** none (SELECT on catalogs). Results hold names only, no row data.

## O6: WAF, rate limits, alerts, readiness restriction

- **You do (Cloudflare dashboard):** create the rules and alerts in `infra/launch/o6-cloudflare-rules.md`
  starting in log mode; the readiness cache is already in code.
- **Acceptance:** the checklist at the end of that file.
- **Risk:** rate limits count by IP; carrier NAT can block real customers.

## O7: backups and restore time

- **You do:** pick the storage, create the read-only `mm_backup` role (reviewed on a branch), set the
  job and its secrets (names in the runbook), run the drill and fill in the restore times.
- **Acceptance:** `infra/neon/backup-restore-runbook.md` section 4.
- **Risk:** the dump holds customer phones and addresses: key custody and retention are the controls.

## Gate (P1 closes only when all are ticked)

- [ ] D1 policy accepted; the branch readiness check seen (503 then 200).
- [ ] S2 revoke run on a branch, integration suite green, run on production, `10`/`20` updated.
- [ ] P1 cart-read optimisation approved, done and measured.
- [ ] O4 decision taken (and the Function check built, or "no staging" recorded).
- [ ] O5 results reviewed and any follow-up decided.
- [ ] O6 rules and alerts live and tested.
- [ ] O7 backup running and a restore time recorded.
