# P1 Preparation Summary

**Status:** Ready for team action on 7-item gate  
**Last updated:** 2026-11-24  
**All work:** source-only, no production impact, no database writes, no credentials exposed

## Completed work (from P0 and ongoing)

### Admin app improvements (P0)
- ✓ Error boundaries: `apps/admin/src/app/[locale]/error.tsx` (generic error display, support code, retry)
- ✓ Not-found handler: `apps/admin/src/app/[locale]/not-found.tsx` (404 with locale-aware link)
- ✓ i18n: added `errors.notFoundTitle` and `errors.notFoundMessage` to `uz.ts`, `ru.ts`, `types.ts`
- ✓ Tests: 3 new tests in `apps/admin/src/app/[locale]/error-pages.test.ts` (all passing)
- ✓ Verification: 371/371 admin tests passing, eslint clean, typecheck clean

### Roadmap and documentation
- ✓ `infra/launch/roadmap.md`: canonical P0/P1/P2 list (P0 committed in cefd503)
- ✓ `infra/launch/p1-handoff.md`: detailed state of each P1 item (prepared/open/closed)
- ✓ Verified: ADR 0019, readiness probes, migration-policy test all in place

## P1 Gate items status

### D1: Expand-then-contract migration policy
- **State:** Prepared, documented, enforcement test active
- **What's done:**
  - `architecture/0019-expand-then-contract-migrations.md` written and marked accepted
  - `services/core-api-function/src/readiness.ts` probes security-state tables + 0007-0009 objects
  - `services/core-api-function/test/unit/migration-policy.test.ts` enforces `# contract:` marker (535 tests passing)
  - `infra/launch/launch-checklist.md` updated with explicit D1 deploy order (migrate → grants → verify → Function → health/ready)
- **Needs:**
  - [ ] Team approves the policy (read ADR 0019)
  - [ ] Branch test: migrate to 0008 only, verify `/health/ready` is 503; migrate to 0009, verify 200
- **Gate line:** D1 policy accepted; the branch readiness check seen (503 then 200)

### S2: Revoke DELETE on `orders`, `order_items`, `order_status_history`
- **State:** SQL prepared, documented, ready for branch run
- **What's done:**
  - Audit complete: no deletes of these tables in Function code
  - `infra/neon/review/s2-revoke-delete-order-history.sql` ready with step-by-step guide
  - `infra/neon/review/README.md` documents the process
- **Needs:**
  - [ ] Branch run: STEP 0, 1 (dry run), 2, 3
  - [ ] Integration test run on branch
  - [ ] Production run
  - [ ] Fold MAKE IT STICK lines into 10-runtime-grants.sql and 20-verify-runtime-role.sql
- **Gate line:** S2 revoke run on branch, integration suite green, run on production, `10`/`20` updated

### P1: Cart-read optimization
- **State:** Not started (requires security review)
- **What's needed:**
  - [ ] Security team approves session/rate-limit transaction changes
  - [ ] Test database available for round-trip measurement
  - [ ] Code review and approval
  - [ ] Measurement: ~17 round-trips → well below 1 per read
- **Gate line:** P1 cart-read optimization approved, done and measured

### O4: Staging environment isolation strategy
- **State:** Dual-layer protection verified, decision framework created
- **What's done:**
  - `validate-deploy-env.mts --mode staging` enforces config-time check (tested)
  - Request-time secret verification in place (different secrets)
  - `infra/launch/o4-staging-environment-isolation-decision.md` created with two options
  - `infra/README.md` updated with acceptance checks for staging
- **Needs:**
  - [ ] Team chooses: Option A (dual-layer, status quo) or Option B (add APP_ENV fail-closed check)
  - [ ] If Option B: implement APP_ENV check in gateway-to-Function path (requires careful review)
  - [ ] Record decision in o4-staging-environment-isolation-decision.md
- **Gate line:** O4 decision taken (and the Function check built, or "no staging" recorded)

### O5: Inventory and PUBLIC privilege audit
- **State:** SQL prepared, ready for branch run
- **What's done:**
  - `infra/neon/review/o5-inventory-and-public-privileges.sql` with 15 read-only queries
  - Documented what to look for: unexpected schemas, PUBLIC grants, publications, triggers
- **Needs:**
  - [ ] Run on a Neon branch (read-only)
  - [ ] Send results to team
  - [ ] Review and decide on any follow-up
- **Gate line:** O5 results reviewed and any follow-up decided

### O6: Cloudflare WAF and rate-limit rules
- **State:** Rules documented, ready for Cloudflare dashboard
- **What's done:**
  - `infra/launch/o6-cloudflare-rules.md` with detailed rule parameters
  - Rules for managed policies, rate limiting, alerts, readiness cache restriction
- **Needs:**
  - [ ] Cloudflare dashboard access
  - [ ] Create rules in log mode first
  - [ ] Follow acceptance checklist in o6-cloudflare-rules.md
- **Gate line:** O6 rules and alerts live and tested

### O7: Backups and restore time
- **State:** Runbook documented, ready for setup
- **What's done:**
  - `infra/neon/backup-restore-runbook.md` with backup strategy and restore drill procedure
- **Needs:**
  - [ ] Pick storage solution
  - [ ] Create `mm_backup` read-only role (review on branch first)
  - [ ] Set up job and secrets
  - [ ] Run restore drill
  - [ ] Record restore time in runbook
- **Gate line:** O7 backup running and a restore time recorded

## Database handoff (blocked)

The following items require database operations and are **blocked** until after P1 gate decision:

1. **S2 production run:** Revoke DELETE privileges (requires psql or SQL Editor on production branch)
2. **O5 branch run:** Run inventory/privilege audit queries (requires SQL Editor on branch)
3. **O7 job setup:** Backup job + restore drill (requires storage + read-only role grant)

Each of these is documented SQL-only; execution will follow the documented process on a Neon branch first, then production.

## Next steps

1. **D1 team decision** (highest priority): Review ADR 0019, verify policy is acceptable
2. **O4 team decision:** Choose Option A or B for APP_ENV check
3. **Branch testing:** Once D1 approved, run branch readiness check
4. **P1 security review:** Schedule security approval for cart-read optimization
5. **Other items:** O5/O6/O7 can proceed in parallel once team has decisions

---

**To tick a gate line:** Update the checkbox in `infra/launch/p1-handoff.md` section "Gate" and sync this summary.
