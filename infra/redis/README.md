# Managed Redis

Redis holds only short-lived security state: browser sessions (`mm:sess:*`), rate-limit windows
(`mm:rl:*`) and service-request replay nonces (`mm:svc-nonce:*`). It is **not** replaced by
Workers KV or D1: sessions and rate limits need atomic `INCR`/Lua and strong consistency, which KV
does not offer. Every key has a TTL. Losing Redis signs everyone out; the API then fails closed
(`503 service_unavailable`) instead of skipping checks.

## Rules

- **TLS only**: `REDIS_URL=rediss://<user>:<password>@<host>:<port>/<db>`. The API refuses to start
  in staging/production with `redis://`. The URL is a Worker secret on the gateway, never in the
  repository or a frontend.
- **One instance per environment** (or, at minimum, one database plus one ACL user per
  environment on a shared plan). Staging credentials can never read production keys.
- **ACL user** per environment, restricted to the application's keys and commands:
  `~mm:* +@read +@write +@string +@keyspace +@scripting +@transaction +ping -@dangerous`.
  Adjust to the provider's ACL syntax; keep `FLUSHALL`, `CONFIG`, `KEYS` and `DEBUG` denied.
- **Key prefix**: everything the API writes starts with `mm:` (`app/security/session.py`,
  `rate_limit.py`, `service_auth.py`). Do not share an environment's Redis with any other
  application; if a provider forces sharing, give each application its own database number and
  ACL user, never just a different prefix.
- **Eviction policy `noeviction`**: an evicted nonce would weaken replay protection and an evicted
  rate-limit window would reset a limit. With `noeviction`, a full Redis makes writes fail and the
  API fails closed. Alert on memory > 70%.
- **Persistence** is optional (all data is reconstructible: users sign in again). Prefer a
  provider plan with replication/high availability over persistence.
- **Region**: same as the Neon database and close to the containers; the session lookup is on
  every authenticated request.
- **Timeouts**: the client uses the redis-py defaults; readiness (`/api/v1/health/ready`) pings
  Redis, so a broken connection takes instances out of service visibly.

## Checklist (per environment)

- [ ] Instance created in the chosen region, TLS enforced, public access limited to TLS.
- [ ] ACL user created as above; default user disabled or password-protected and unused.
- [ ] `maxmemory-policy noeviction`; memory and connection alerts configured.
- [ ] `REDIS_URL` stored as a gateway Worker secret (`rediss://`).
- [ ] From a staging container: readiness `200`, sign-in, logout and a rate-limited endpoint work.
