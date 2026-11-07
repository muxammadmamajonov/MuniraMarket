# ADR 0013 — Security state in PostgreSQL (no Redis in production)

- Status: accepted
- Supersedes: the Redis parts of [0007](0007-browser-sessions-csrf.md), [0003](0003-service-auth-contract.md) (replay store) and [0011](0011-cloudflare-neon-deployment.md)

## Context

Sessions, rate-limit windows and ADR 0003 replay nonces lived in a managed Redis. Production will
not run a separate Redis: one less provider, secret, region and failure mode. The only database is
the existing Neon project `munira-market` (production branch). The guarantees of ADR 0007 must
survive the move: session rotation never forks or resurrects a session, logout/block wins against
parallel requests, a nonce is accepted once, rate-limit hits are atomic, and every store failure
fails closed (`503`). Cloudflare KV, the Cache API and Cloudflare's own rate-limiting binding are
eventually consistent or approximate and are **not** used for any of this.

## Decision

Four tables (migration `0005`), all keyed by a hash or a composite identifier, each with an
`expires_at` and an index on it:

| Table                    | Replaces                     | Atomic operation                                                     |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------- |
| `auth_sessions`          | `mm:sess:<sha256(token)>`    | rotation: one transaction, `SELECT … FOR UPDATE` on the old row      |
| `rate_limit_counters`    | `mm:rl:<scope>:<subj>:<win>` | `INSERT … ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits`  |
| `service_request_nonces` | `mm:svc-nonce:<key>:<nonce>` | `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now RETURNING` |
| `oidc_login_states`      | (new, ADR 0014)              | `DELETE … RETURNING` (consumed exactly once)                         |

- **Expiry is exact without any background job**: every read and update filters on
  `expires_at > now` (now from the API's injectable clock). An expired row is invisible and can
  never be revived (`expire` only touches unexpired rows, as Redis `EXPIRE` never recreated keys).
- **Rotation** keeps the ADR 0007 semantics: under READ COMMITTED, a request waiting on the row
  lock re-reads the row once the winner commits; it sees the tombstone (`ALREADY_ROTATED`, served
  without a cookie) or nothing after a concurrent logout/block (`GONE`, `401`). Tombstones carry no
  `user_id`, so a user always has at most one live row per session.
- **Separate transactions**: each store operation uses its own short transaction on the API's
  pool, so a route that rolls back never undoes a hit, a nonce or a rotation.
- **Fail closed**: any `SQLAlchemyError`/`OSError`/timeout becomes `StoreUnavailableError` → `503`.
  Readiness probes every security table with `SELECT 1 FROM <table> LIMIT 0`, so a missing
  migration or grant takes an instance out of service.
- **No secret in the database**: only `sha256` of session tokens, OIDC states and binding values.
  The PKCE verifier of a pending login lives at most 10 minutes and is useless without the
  single-use authorization code.
- **Cleanup**: `POST /api/v1/internal/maintenance/cleanup` (signed, empty actor) deletes expired
  rows in batches of 5000 (`ctid IN (SELECT … LIMIT …)`), at most 20 batches per table per run. The
  gateway's Cron Trigger calls it every 15 minutes (ADR 0015). Correctness never depends on it.
- **Roles**: the tables are ordinary DML tables for `mm_app` (`10-runtime-grants.sql` already
  grants DML on all tables); migrations run as `mm_migrator`. The Neon owner role is not used.
- **Tests**: unit tests keep the in-memory stores; `tests/test_security_state_integration.py`
  runs the PostgreSQL stores against a real migrated schema, including concurrent rotation,
  concurrent rate-limit hits, concurrent identical nonces and concurrent state consumption.

## Consequences

- Every rate-limited request is one small write, and every authenticated request one or two more
  queries. At launch scale this is well within one Neon compute; the per-IP ceilings still run
  before any business query. If write volume becomes a problem, revisit with a dedicated store
  that offers the same atomicity (not KV).
- Neon availability is now also session availability; there is one dependency instead of two.
- Redis, `REDIS_URL`, the Redis CI services and `infra/redis/` are removed.
