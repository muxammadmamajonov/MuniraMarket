# Cloudflare: Workers, Containers, environments

Configuration lives next to each app (`cloudflare.config.ts`, `vite.config.ts`); this directory
holds what they share (`environments.mts`, `vinext.mts`), the deploy-time validator and the smoke
test. Design: [ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md).

## Workers

| Worker (production name)   | Source                 | Public hostname     | Talks to                               |
| -------------------------- | ---------------------- | ------------------- | -------------------------------------- |
| `muniramarket-web`         | `apps/web` (vinext)    | `MM_WEB_HOSTNAME`   | `CORE_API` → gateway `StorefrontApi`   |
| `muniramarket-admin`       | `apps/admin` (vinext)  | `MM_ADMIN_HOSTNAME` | `CORE_API` → gateway `AdminApi`        |
| `muniramarket-api-gateway` | `services/api-gateway` | `MM_API_HOSTNAME`   | `CoreApiContainer` → FastAPI container |

Staging names end in `-staging`. Deployed Workers have **no `workers.dev` and no preview URLs**:
every extra origin would need to be in `CSRF_TRUSTED_ORIGINS` and the Login Widget domain.
Logs and traces are enabled everywhere, query strings are redacted, production traces are sampled
at 10%.

## Commands (no account needed unless noted)

```bash
# local Workers runtime (workerd) against your local Core API on :8000
pnpm --filter @muniramarket/web preview:worker        # http://localhost:3100
pnpm --filter @muniramarket/admin preview:worker      # http://localhost:3101
node infra/cloudflare/scripts/smoke.mts --local --web http://localhost:3100 --admin http://localhost:3101

# builds and binding types (CI runs these)
pnpm --filter @muniramarket/web build:worker          # --mode staging
pnpm --filter @muniramarket/web typecheck:worker
cd services/api-gateway && pnpm exec cf build --mode staging   # also builds the API image (Docker)
```

`next dev` (port 3000/3001) is unchanged and remains the everyday development loop.

## Deploy-time variables (not secret, not committed)

Copy [`deploy-env.example`](deploy-env.example) to a git-ignored file, fill it in, export it, and
validate before every deploy:

```bash
node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging
```

| Variable                   | Used by       | Notes                                                                                       |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `MM_WEB_HOSTNAME`          | web           | storefront + Mini App host                                                                  |
| `MM_ADMIN_HOSTNAME`        | admin         | separate origin from the storefront                                                         |
| `MM_API_HOSTNAME`          | gateway       | Telegram Serverless and health checks only                                                  |
| `MM_TELEGRAM_BOT_ID`       | gateway → API | numeric bot id                                                                              |
| `MM_TELEGRAM_BOT_USERNAME` | gateway → API | Login Widget                                                                                |
| `MM_CSRF_TRUSTED_ORIGINS`  | gateway → API | exactly `https://<web>,https://<admin>`                                                     |
| `CORE_API_IMAGE`           | gateway       | `registry.cloudflare.com/<account>/muniramarket-core-api@sha256:…` (required in production) |
| `APP_RELEASE`              | gateway → API | the image tag, e.g. `sha-0123456789ab` (required in production)                             |

## Secrets: where each one lives

| Secret                                          | Stored as                                                                                               | Rotation                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL` (`mm_app`, `?ssl=verify-full`)   | Worker secret on `muniramarket-api-gateway[-staging]`                                                   | new password in Neon (`ALTER ROLE`), update secret, redeploy |
| `REDIS_URL` (`rediss://`)                       | Worker secret on the gateway                                                                            | provider ACL password, update secret                         |
| `SERVICE_AUTH_KEYS`                             | Worker secret on the gateway **and** Telegram Serverless config                                         | two keys at once (ADR 0003), then drop old                   |
| `TELEGRAM_BOT_TOKEN`                            | Worker secret on the gateway; Telegram Serverless platform                                              | BotFather `/revoke`, update both                             |
| `MIGRATION_DATABASE_URL` (`mm_migrator`)        | GitHub Environment secret (`staging`/`production`, required reviewers) or the operator's secret manager | per migration window                                         |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Environment secrets, scoped tokens only                                                          | per token policy                                             |
| R2 credentials                                  | none: R2 is used through a Worker binding (r2/README.md)                                                | n/a                                                          |

The web and admin Workers hold **no secrets**. Set gateway secrets per environment with Wrangler
(cf does not yet set single secrets) or upload them with the version:

```bash
npx wrangler secret put DATABASE_URL --name muniramarket-api-gateway-staging
# or: cf deploy --mode staging --secrets-file <git-ignored file>
```

`cloudflare.config.ts` declares them with `bindings.secret()`, so a deploy with a missing secret
fails instead of starting a container without it. Secrets reach the container as environment
variables when an instance starts; a rotated secret applies to instances started afterwards
(restart the pool by deploying).

## Deploy order (per environment)

1. **Image**: the `Core API image` workflow builds `sha-<12 hex>` on `main`; with pushing enabled
   it records `CORE_API_IMAGE` (digest) in the run summary.
2. **Migrations** (only if the release has any): Neon restore point first (neon/README.md), then
   the one-off job with `APP_ENV` and `MIGRATION_DATABASE_URL` only:
   `docker run --rm -e APP_ENV -e MIGRATION_DATABASE_URL <image> alembic upgrade head`, then
   `infra/neon/sql/10-runtime-grants.sql` and `20-verify-runtime-role.sql` as `mm_migrator`.
   Migrations must be backward compatible with the running release (expand → deploy → contract).
3. **Gateway**: `cd services/api-gateway && cf deploy --mode <env>` with the validated variables.
4. **Admin, then web**: `cf deploy --mode <env>` in each app (they bind to the gateway by name, so
   the gateway goes first).
5. **Smoke test**: `node infra/cloudflare/scripts/smoke.mts --web https://… --admin https://… --api https://…`
6. Watch Workers Logs / container logs for 15 minutes (5xx, `service_unavailable`, readiness).

Production is deployed from the same commit and the same image digest that passed staging.

## Rollback

- **Workers code**: roll back to the previous version (`cf`/dashboard _Deployments_); instant,
  per Worker. Roll back web/admin and the gateway together if the change spans them.
- **API image**: redeploy the gateway with the previous `CORE_API_IMAGE` digest; Containers
  replace instances with `SIGTERM` (graceful) and a rolling start.
- **Database**: never roll back a migration in production by hand. Prefer a forward fix. If data
  is damaged, restore from the pre-migration restore point (neon/README.md) and redeploy the
  matching image. Rollback does not restore data in R2, Redis or Neon by itself.
- Redis holds only sessions, rate-limit windows and nonces: flushing it signs everyone out and is
  otherwise safe.

## Client IP and proxy trust

Cloudflare sets `CF-Connecting-IP`; the apps forward it as `X-Forwarded-For`
(`CLIENT_IP_HEADER=cf-connecting-ip`), the gateway accepts it only as a single IP and always
writes `X-Forwarded-For` itself. `FORWARDED_ALLOW_IPS` on the API trusts the private ranges the
platform's container proxy connects from; after the first staging deploy, narrow it to the
observed peer range.
