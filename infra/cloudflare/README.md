# Cloudflare: Workers and environments (Free plan)

Configuration lives next to each app (`cloudflare.config.ts`, `vite.config.ts`); this directory
holds what they share (`environments.mts`, `vinext.mts`), the deploy-time validator and the smoke
test. Design: [ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md), updated by
[ADR 0016](../../architecture/0016-core-api-on-neon-functions.md): the Core API runs as the
`coreapi` Neon Function; Cloudflare runs Workers only (no Containers, Durable Objects, image
registry, Redis or other compute).

## Workers

| Worker (production name)   | Source                 | Public hostname     | Talks to                             |
| -------------------------- | ---------------------- | ------------------- | ------------------------------------ |
| `muniramarket-web`         | `apps/web` (vinext)    | `MM_WEB_HOSTNAME`   | `CORE_API` → gateway `StorefrontApi` |
| `muniramarket-admin`       | `apps/admin` (vinext)  | `MM_ADMIN_HOSTNAME` | `CORE_API` → gateway `AdminApi`      |
| `muniramarket-api-gateway` | `services/api-gateway` | `MM_API_HOSTNAME`   | Neon Function `coreapi` (HTTPS)      |

Staging names end in `-staging`. Deployed Workers have **no `workers.dev` and no preview URLs**:
every extra origin would need to be in `CSRF_TRUSTED_ORIGINS` and registered as a Telegram OIDC
redirect URL. Production hostnames are fixed: storefront `muniramarket.uz`, admin
`admin.muniramarket.uz` (their `/api/v1/auth/telegram/oidc/callback` URLs are registered with
BotFather); `munira-market.uz` is not canonical. The API hostname serves only health checks and the
two service-signed Telegram Serverless routes (`internal/telegram/session`,
`internal/telegram/staff-chat/connect`). Browsers never see the Function URL.
Logs and traces are enabled everywhere, query strings are redacted, production traces are sampled
at 10%.

## Commands (no account needed unless noted)

```bash
# local Workers runtime (workerd) against your local Core API on :8000
# (pnpm --filter @muniramarket/core-api-function dev: the Function behind a local gateway stand-in)
pnpm --filter @muniramarket/web preview:worker        # http://localhost:3100
pnpm --filter @muniramarket/admin preview:worker      # http://localhost:3101
node infra/cloudflare/scripts/smoke.mts --local --web http://localhost:3100 --admin http://localhost:3101

# builds and binding types (CI runs these)
pnpm --filter @muniramarket/web build:worker          # --mode staging
pnpm --filter @muniramarket/web typecheck:worker
cd services/api-gateway && pnpm exec cf build --mode staging   # Worker bundle only (no image)
```

`next dev` (port 3000/3001) is unchanged and remains the everyday development loop.

## Deploy-time variables (not secret, not committed)

Copy [`deploy-env.example`](deploy-env.example) to a git-ignored file, fill it in, export it, and
validate before every deploy:

```bash
node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging
```

| Variable                  | Used by            | Notes                                                                       |
| ------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `MM_WEB_HOSTNAME`         | web                | storefront + Mini App host                                                  |
| `MM_ADMIN_HOSTNAME`       | admin              | separate origin from the storefront                                         |
| `MM_API_HOSTNAME`         | gateway            | Telegram Serverless and health checks only                                  |
| `MM_TELEGRAM_BOT_ID`      | Function (neon.ts) | `TELEGRAM_BOT_ID` / `TELEGRAM_OIDC_CLIENT_ID` (production: `9038491407`)    |
| `MM_CSRF_TRUSTED_ORIGINS` | Function (neon.ts) | `CSRF_TRUSTED_ORIGINS`: exactly `https://<web>,https://<admin>`             |
| `APP_RELEASE`             | Function (neon.ts) | release label on every log line, e.g. `sha-0123456789ab` (required in prod) |

## Secrets: where each one lives

| Secret                                                            | Stored as                                                                                                | Rotation                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `CORE_API_FUNCTION_ORIGIN`                                        | Worker secret on `muniramarket-api-gateway[-staging]` (the Function's `invocation_url`)                  | only if the Function moves branch/project                                     |
| `CORE_API_FUNCTION_SECRET`                                        | Worker secret on the gateway **and** Neon Function env (`neon.ts`), same value                           | see "Rotating" below                                                          |
| `SCHEDULER_SERVICE_SECRET`                                        | Worker secret on the gateway; the Function's `SERVICE_AUTH_KEYS` holds `scheduler:<same value>`          | add the new pair to `SERVICE_AUTH_KEYS`, update the Worker, drop the old pair |
| `SERVICE_AUTH_KEYS`                                               | Neon Function env only (incl. `scheduler`); Telegram Serverless config has its own entry                 | two keys at once (ADR 0003), then drop old                                    |
| `TELEGRAM_BOT_TOKEN`                                              | Neon Function env (initData HMAC + outbox drain); Telegram Serverless platform                           | BotFather `/revoke`, update both                                              |
| `TELEGRAM_OIDC_CLIENT_SECRET`                                     | Neon Function env only; server-side OIDC code exchange (ADR 0014)                                        | BotFather → Login Widget, regenerate, update the Function                     |
| `MM_APP_DATABASE_URL`                                             | Neon Function env only: pooled endpoint, `mm_app` + its own password, `sslmode=require`                  | new `mm_app` password (`ALTER ROLE`), update the Function env, redeploy       |
| `DATABASE_URL`                                                    | never set by hand; Neon may inject it (owner role); the Core API never reads it                          | n/a                                                                           |
| `DATABASE_URL_UNPOOLED` / `MIGRATION_DATABASE_URL`                | Alembic only: GitHub Environment secret or the operator's secret manager                                 | per migration window                                                          |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                   | GitHub Environment secrets, scoped tokens only                                                           | per token policy                                                              |
| R2 credentials                                                    | none: R2 is used through a Worker binding (r2/README.md)                                                 | n/a                                                                           |
| `YANDEX_MAPS_JAVASCRIPT_API_KEY` / `YANDEX_MAPS_GEOCODER_API_KEY` | Worker secrets on `muniramarket-web[-staging]`; both are intentionally visible to the browser at runtime | create/restrict replacement keys in Yandex                                    |

The admin Worker holds **no secrets**; the gateway holds only the three above. Set Worker
secrets per environment with Wrangler (cf does not yet set single secrets) or upload them with the
version, never echoing a value in a shared terminal:

```bash
npx wrangler secret put CORE_API_FUNCTION_ORIGIN --name muniramarket-api-gateway-staging
# or: cf deploy --mode staging --secrets-file <git-ignored file>
```

`cloudflare.config.ts` declares them with `bindings.secret()`, so a deploy with a missing secret
fails. A missing or malformed origin/secret at runtime makes the gateway answer `503` without
calling anything (fail closed).

**Rotating `CORE_API_FUNCTION_SECRET`** (one value on both sides; any mismatch is a 401 on every
request): deploy the Function with the new value, then immediately put the new Worker secret.
Plan a quiet minute; the Function logs `401`s from the gateway in between.

## Deploy order (per environment)

1. **Migrations** (only if the release has any): Neon restore point first (neon/README.md), then
   Alembic with `APP_ENV` and `MIGRATION_DATABASE_URL` (the migrator role, direct/unpooled URL)
   only: `cd services/api && uv run alembic upgrade head`, then
   `infra/neon/sql/10-runtime-grants.sql` and `20-verify-runtime-role.sql` as `mm_migrator`.
   Migrations must be backward compatible with the running release (expand → deploy → contract).
2. **Core API Function**: `neon config plan --env <git-ignored file>` must show only
   `coreapi`; then `neon deploy --env <file>` (infra/neon/README.md). Note its `invocation_url`.
3. **Gateway**: Worker secrets set (above), then `cd services/api-gateway && cf deploy --mode <env>`.
4. **Admin, then web**: `cf deploy --mode <env>` in each app (they bind to the gateway by name, so
   the gateway goes first).
5. **Smoke test**: `node infra/cloudflare/scripts/smoke.mts --web https://… --admin https://… --api https://…`
6. Watch Workers Logs and `neon logs query --branch production --source function --since 15m`
   (5xx, `service_unavailable`, readiness, gateway `upstream rejected the request`).

Production is deployed from the same commit that passed CI (and staging, when one exists).

## Rollback

- **Workers code**: roll back to the previous version (`cf`/dashboard _Deployments_); instant,
  per Worker. Roll back web/admin and the gateway together if the change spans them.
- **Core API Function**: redeploy the previous commit's `services/core-api-function` with
  `neon deploy` (each deploy is a new Function deployment; isolates drain in-flight requests).
- **Database**: never roll back a migration in production by hand. Prefer a forward fix. If data
  is damaged, restore from the pre-migration restore point (neon/README.md) and redeploy the
  matching Function code. Rollback does not restore data in R2 or Neon by itself.
- Sessions, rate-limit windows, nonces and OIDC states are rows in Neon (ADR 0013); a database
  restore therefore also restores (or drops) sign-ins. Deleting `auth_sessions` signs everyone out
  and is otherwise safe.

## Scheduler (Cron Trigger)

The gateway keeps a Cloudflare Cron Trigger `* * * * *` in deployed modes (ADR 0015, ADR 0016; no
Neon Function Trigger). A Free-plan invocation has 10 ms of CPU, so each tick only signs (ADR 0003,
empty actor, key id `SCHEDULER_SERVICE_KEY_ID`, secret `SCHEDULER_SERVICE_SECRET`) and forwards
`POST internal/scheduler/notifications/drain`; every 15th minute also
`POST internal/maintenance/cleanup`. The Function does the batch work next to Postgres: it claims
the outbox (60 s lease, `attempt` fencing), sends the Telegram messages and reports outcomes, so an
overlapping, late or failed tick never loses or double-reports a notification. Without the secret
every tick logs `signing key unavailable` and nothing is delivered.

## Client IP and proxy trust

Cloudflare sets `CF-Connecting-IP`; the apps forward it as `X-Forwarded-For`
(`CLIENT_IP_HEADER=cf-connecting-ip`), the gateway accepts it only as a single IP and always
writes `X-Forwarded-For` itself. The Function trusts that header because every request it serves
carries the gateway secret; a request without it is rejected before anything else happens.

The storefront's optional map step reads `YANDEX_MAPS_JAVASCRIPT_API_KEY` and
`YANDEX_MAPS_GEOCODER_API_KEY` at runtime. They are web Worker secrets, but necessarily become
visible to browsers in Yandex requests. Restrict each in the Yandex console by HTTP Referer to
the storefront domain; never put them in Git or the admin/gateway Worker. Without the JavaScript
key the picker shows "map unavailable"; without the Geocoder key the map works but the customer
must choose a district from the list.
