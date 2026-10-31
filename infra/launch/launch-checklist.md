# Production launch checklist

Tick every line on the real production environment. Values (domains, ids, URLs) go into the
operator's records and the deploy environment, never into this repository.

## 0. Gate

- [ ] `main` CI is green (JS, Core API, Workers, contracts, E2E, secret scan).
- [ ] Staging ran the exact commit and image digest for at least 48 h with the device UAT passed.
- [ ] `node infra/cloudflare/scripts/launch-gate.mts` passes with the production variables.

## 1. Cloudflare account, DNS and domains

- [ ] Account with 2FA for every member; members have the least role they need; API tokens are
      scoped (Workers Scripts/Containers edit for the deploy token, nothing account-wide).
- [ ] Zone active on Cloudflare; DNSSEC on; registrar lock on.
- [ ] Three hostnames chosen and recorded: storefront (`MM_WEB_HOSTNAME`), admin
      (`MM_ADMIN_HOSTNAME`), API (`MM_API_HOSTNAME`); all different origins.
- [ ] Custom domains attached by deploy (`domains` in `cloudflare.config.ts`); certificates issued;
      SSL/TLS mode Full (strict); Always Use HTTPS; minimum TLS 1.2; HSTS enabled after the first
      successful smoke test (start with a short max-age, no preload until stable).
- [ ] `workers.dev` and preview URLs are off for the three deployed Workers (they are in config).
- [ ] WAF managed rules on; a rate-limiting rule for `/api/v1/auth/*` on the storefront and
      admin hostnames as a second layer above the API's own limits.
- [ ] A rate-limiting rule on the API hostname (`/api/v1/health*` and `/api/v1/internal/*`):
      every request there wakes a container, and health readiness touches the database and Redis.
- [ ] Optional: Cloudflare Access in front of the admin hostname (staff identity before the app's
      own Telegram sign-in).

## 2. Workers secrets and variables

- [ ] Gateway secrets set for production: `DATABASE_URL` (mm_app, `?ssl=verify-full`), `REDIS_URL`
      (`rediss://`), `SERVICE_AUTH_KEYS`, `TELEGRAM_BOT_TOKEN` (infra/cloudflare/README.md).
- [ ] Web and admin Workers have no secrets.
- [ ] `node infra/cloudflare/scripts/validate-deploy-env.mts --mode production` passes;
      `CORE_API_IMAGE` is the digest that passed staging; `APP_RELEASE` is its tag.
- [ ] Workers Logs and Traces visible for all three Workers; container logs visible; an alert on
      5xx rate and on `service_unavailable`.

## 3. Neon

- [ ] Separate production project, region chosen, restore window set to the plan maximum.
- [ ] `01-roles.sql`, `02-database.sql` applied; migrations as `mm_migrator`; `10-runtime-grants.sql`
      and `20-verify-runtime-role.sql` pass.
- [ ] `DATABASE_URL` uses `mm_app`; the owner role is used by nobody day to day.
- [ ] Restore drill done once (infra/neon/README.md), time-to-restore recorded.
- [ ] Production contains no seed/demo data (`make seed` refuses outside development/test).

## 4. Redis

- [ ] Production instance (not shared with staging), TLS, ACL user per infra/redis/README.md,
      `noeviction`, memory alert.

## 5. R2

- [ ] Either still disabled (admin preview placeholder, pasted `https` image URLs) **or** the
      enablement checklist in infra/r2/README.md is complete. Not half-enabled.

## 6. Telegram

- [ ] BotFather: production bot token issued; staging uses a different bot.
- [ ] BotFather `/setdomain`: the **admin** hostname for the Login Widget (the storefront website
      sign-in too, if enabled there; the widget allows one domain per bot, so decide which origin
      uses it and record it).
- [ ] Mini App: main app / menu button URL set to `https://<storefront host>/uz` (or the chosen
      locale entry); opened from the bot in Telegram iOS, Android and Desktop.
- [ ] Telegram Serverless: Core API base URL is `https://<API host>`; `SERVICE_AUTH_KEYS` entry
      matches the gateway's; the order-notification drain trigger is configured in BotFather /
      the Serverless project and delivers a test notification on staging.
- [ ] `TELEGRAM_ENVIRONMENT=production`, `TELEGRAM_BOT_ID` matches the bot.

## 7. Admin and staff

- [ ] Admin origin is in `MM_CSRF_TRUSTED_ORIGINS`; sign-in works only on the admin hostname.
- [ ] First admin promoted with a reviewed one-off `set_role` run against production (development
      tool refuses outside development/test, so use a reviewed SQL `UPDATE users SET role = 'admin'`
      by the owner role, recorded in the incident/change log); a second admin exists (`last_admin`).
- [ ] Operators have `operator`, not `admin`.

## 8. Go-live verification

- [ ] `node infra/cloudflare/scripts/smoke.mts --web … --admin … --api …` passes.
- [ ] Real order placed and cancelled end to end on production with a staff test account
      (cash on delivery), status notifications received in Telegram, audit log entries present.
- [ ] Device UAT (device-uat-checklist.md) passed on production for at least one iPhone and one
      Android phone.
- [ ] Legal pages published (legal-content-checklist.md) and linked from the storefront footer
      and the checkout.

## 9. Rollback readiness

- [ ] Previous Worker versions and the previous image digest are known (none before the first
      launch: rollback = take the storefront offline with a maintenance response).
- [ ] Who can roll back, and how, is written down: Workers rollback, gateway redeploy with the
      previous digest, Neon restore point (infra/cloudflare/README.md, infra/neon/README.md).
- [ ] On-call contact for launch day and the first week.
