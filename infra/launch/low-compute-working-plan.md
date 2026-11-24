# Working plan for a limited compute allowance

The Claude Code / host compute allowance (reported as 93.6 % used) is a property of the host and
the account. Nothing in this repository or in a session can raise, reset or change it. This file
only records how to spend what is left.

## Rules for the next runs

1. **One job at a time.** No parallel agents, no parallel test runs (`pnpm -r` already runs
   packages concurrently: use `pnpm --filter <pkg>` instead).
2. **Only the touched package.** Lint, typecheck and test the package that changed, nothing else:

   | Changed                      | Command                                                                      |
   | ---------------------------- | ---------------------------------------------------------------------------- |
   | `apps/web`                   | `pnpm --filter @muniramarket/web lint typecheck test`                        |
   | `services/core-api-function` | `pnpm --filter @muniramarket/core-api-function lint typecheck test`          |
   | `infra/cloudflare`           | `pnpm --filter ./infra/cloudflare typecheck test`                            |
   | `packages/contracts`         | the above plus every package that imports it (web, admin, core-api-function) |
   | docs/SQL only                | `pnpm exec prettier --check <files>` and nothing else                        |

   A single file: `pnpm --filter <pkg> exec vitest run path/to/file.test.ts`.

3. **No full audit again.** The full audit and the P0/P1 verification already ran; their results
   are in `infra/launch/p1-handoff.md`. Re-run a full workspace check **once**, at the very end,
   before a human commits.
4. **Skip what cannot run here:** Playwright E2E, DB-backed integration tests (no database in the
   session), the Python API suite (needs a clean checkout, see the `.env` note). They run in CI.
5. **Read less.** Use `grep -n` / targeted ranges instead of reading whole files; never print
   whole logs, only `tail`/`grep` of failures.
6. **Stop when blocked on the user.** The remaining P1 items need access or decisions, not more
   analysis: do not spend runs re-deriving them.

## What the repo could do to cost less (documented, not changed)

- CI already splits JS, Core API, Workers, contracts and E2E; keep running E2E in CI only.
- `pnpm test` at the root runs every package. A per-package `--filter` (above) is the cheap path.
- Vitest `--changed` (`pnpm --filter <pkg> exec vitest run --changed`) runs only tests related to
  uncommitted changes; use it for quick loops, then the package's full run once.
- The web build/typecheck regenerates Cloudflare types each time (`cf workers types`); avoid
  re-running `typecheck` for `apps/web` and `apps/admin` repeatedly in a loop.
