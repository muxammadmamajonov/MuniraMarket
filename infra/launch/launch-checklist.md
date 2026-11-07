# Production launch checklist

Tick every line on the real production environment. Values (domains, ids, URLs) go into the
operator's records and the deploy environment, never into this repository.

## 0. Gate

- [ ] `main` CI is green (JS, Core API, Workers, contracts, E2E, secret scan).
- [ ] The exact commit (Function deployment + Worker versions) ran on the production project before opening to customers
      (soft launch: staff only) for at least 48 h with the device UAT passed. No staging project
      exists (one Neon project, ADR 0013).
- [ ] `node infra/cloudflare/scripts/launch-gate.mts` passes with the production variables.

## 1. Cloudflare account, DNS and domains

- [ ] Account with 2FA for every member; members have the least role they need; API tokens are
      scoped (Workers Scripts edit for the deploy token, nothing account-wide; a Neon API key limited
      to the project for `neon deploy`).
- [ ] Zone active on Cloudflare; DNSSEC on; registrar lock on.
- [ ] Hostnames: storefront `muniramarket.uz` (`MM_WEB_HOSTNAME`), admin `admin.muniramarket.uz`
      (`MM_ADMIN_HOSTNAME`), API (`MM_API_HOSTNAME`, health + service-signed routes only); all
      different origins. `munira-market.uz` is not canonical (a redirect is a separate decision).
- [ ] Custom domains attached by deploy (`domains` in `cloudflare.config.ts`); certificates issued;
      SSL/TLS mode Full (strict); Always Use HTTPS; minimum TLS 1.2; HSTS enabled after the first
      successful smoke test (start with a short max-age, no preload until stable).
- [ ] `workers.dev` and preview URLs are off for the three deployed Workers (they are in config).
- [ ] WAF managed rules on; a rate-limiting rule for `/api/v1/auth/*` on the storefront and
      admin hostnames as a second layer above the API's own limits.
- [ ] A rate-limiting rule on the API hostname (`/api/v1/health*` and `/api/v1/internal/*`):
      every request there invokes the `coreapi` Function, and health readiness touches the database.
- [ ] Optional: Cloudflare Access in front of the admin hostname (staff identity before the app's
      own Telegram sign-in).

## 2. Workers secrets and variables

- [ ] Gateway Worker secrets set for production: `CORE_API_FUNCTION_ORIGIN`,
      `CORE_API_FUNCTION_SECRET`, `SCHEDULER_SERVICE_SECRET`. Neon Function `coreapi` secrets:
      `MM_APP_DATABASE_URL` (pooled endpoint, `mm_app`, its own password, `sslmode=require`),
      `CORE_API_FUNCTION_SECRET`, `SERVICE_AUTH_KEYS` (with a `scheduler:<≥32 bytes>` entry),
      `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OIDC_CLIENT_SECRET` (infra/cloudflare/README.md). There is
      no `REDIS_URL`, no hand-set `DATABASE_URL` and no second (admin) bot token.
- [ ] `YANDEX_MAPS_API_KEY` is a `muniramarket-web` Worker secret only and is restricted in Yandex
      to `muniramarket.uz`; the admin Worker has no secrets.
- [ ] `node infra/cloudflare/scripts/validate-deploy-env.mts --mode production` passes;
      `neon config plan` shows only `coreapi`; `APP_RELEASE` names the commit; the Function secret
      `MM_APP_DATABASE_URL` (pooled endpoint, `mm_app`, its own password, `sslmode=require`) is set
      in the deploy env file only.
- [ ] Workers Logs and Traces visible for all three Workers; Neon Function logs visible (`neon logs query --source function`); an alert on
      5xx rate and on `service_unavailable`.

## 3. Neon

- [ ] The existing `munira-market` project, production branch (no new project, no staging);
      region chosen; restore window set to the plan maximum; owner password not in any `.env`.
- [ ] `01-roles.sql`, `02-database.sql` applied; migrations as `mm_migrator`; `10-runtime-grants.sql`
      and `20-verify-runtime-role.sql` pass.
- [ ] `MM_APP_DATABASE_URL` connects as `mm_app`; the owner role (incl. Neon's injected
      `DATABASE_URL`) is used by nobody day to day.
- [ ] Migration `0005` applied (security-state tables); readiness is `200` (it probes them).
- [ ] Restore drill done once (infra/neon/README.md), time-to-restore recorded.
- [ ] Production contains no seed/demo data (`make seed` refuses outside development/test).

## 4. Security state (no Redis)

- [ ] Sessions, rate limits, replay nonces and OIDC states are in Neon (ADR 0013); no Redis
      instance, secret or provider account exists for production.
- [ ] Cleanup runs (gateway cron, every 15 min): `auth_sessions`/`rate_limit_counters` stay small.

## 5. R2

- [ ] Either still disabled (admin preview placeholder, pasted `https` image URLs) **or** the
      enablement checklist in infra/r2/README.md is complete. Not half-enabled.

## 6. Telegram (one bot: `9038491407`)

- [ ] BotFather → Login Widget: Client ID `9038491407`; the Client Secret is stored only as the
      gateway secret `TELEGRAM_OIDC_CLIENT_SECRET`; signing algorithm left at RS256; redirect URLs
      `https://muniramarket.uz/api/v1/auth/telegram/oidc/callback` and
      `https://admin.muniramarket.uz/api/v1/auth/telegram/oidc/callback`; trusted origins
      `muniramarket.uz`, `admin.muniramarket.uz`.
- [ ] Browser sign-in works on both hostnames; cancelling on Telegram returns to the sign-in page.
- [ ] Mini App: main app / menu button URL set to `https://muniramarket.uz/uz` (or the chosen
      locale entry); opened from the bot in Telegram iOS, Android and Desktop (initData sign-in).
- [ ] Telegram Serverless (already linked to the bot locally): `npx tgcloud push`, then
      `npx tgcloud webhook` shows the `message` handler in sync; `service_config` holds the Core API
      base URL `https://<API host>` and its own `SERVICE_AUTH_KEYS` entry.
- [ ] The bot is added to the staff group; an admin sends `/connect_orders` (or
      `/connect_orders@<bot>`) there and gets the success reply; a non-admin gets the refusal.
- [ ] Gateway cron is active (Workers → Triggers); a test order produces the customer message and
      the staff group alert within about a minute.
- [ ] `TELEGRAM_ENVIRONMENT=production`, `TELEGRAM_BOT_ID` matches the bot.

## 7. Admin and staff

- [ ] Admin origin is in `MM_CSRF_TRUSTED_ORIGINS`; back-office access needs an OIDC sign-in on the
      admin hostname (a storefront or Mini App session gets `403`).
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

- [ ] Previous Worker versions and the previous Function commit are known (none before the first
      launch: rollback = take the storefront offline with a maintenance response).
- [ ] Who can roll back, and how, is written down: Workers rollback, gateway redeploy with the
      previous digest, Neon restore point (infra/cloudflare/README.md, infra/neon/README.md).
- [ ] On-call contact for launch day and the first week.
