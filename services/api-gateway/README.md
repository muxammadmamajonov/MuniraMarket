# Core API gateway (Cloudflare Worker + Container)

The only way into the FastAPI container on Cloudflare Containers. Design:
[ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md); operations:
[infra/cloudflare](../../infra/cloudflare/README.md).

| Entrance                          | Reached by                                   | Allowed                                                                                                                                 |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `default.fetch` (public hostname) | Telegram Serverless, uptime checks           | `GET /api/v1/health[/ready]`, `POST /api/v1/internal/telegram/**`                                                                       |
| `StorefrontApi` entrypoint        | web Worker service binding `CORE_API`        | everything except `admin/**` and `internal/**`                                                                                          |
| `AdminApi` entrypoint             | admin Worker service binding `CORE_API`      | `admin/**`, `auth/config`, `auth/session`, `auth/logout`, `auth/telegram/oidc/start`, `auth/telegram/oidc/callback`                     |
| `scheduler` (internal only)       | this Worker's own Cron Trigger (`scheduled`) | `POST internal/telegram/notifications/claim`, `POST internal/telegram/notifications/<uuid>/result`, `POST internal/maintenance/cleanup` |

`internal/maintenance/**` is reachable ONLY through the `scheduler` entrance, which has no route,
binding or hostname: `scheduled()` calls `forward(request, env, ctx.exports, 'scheduler')`
in-process. It forwards only the ADR 0003 signature headers plus `Content-Type`/`Accept`, and no
client IP.

`src/routing.ts` holds the policy (pure, unit-tested): path normalisation (encoded `..`/`/`
refused), the allow-lists, and which headers reach the container. The gateway always writes
`X-Forwarded-For` itself (public: `CF-Connecting-IP`; bindings: the single IP the app forwarded)
and sets `X-Request-ID` (public and scheduler callers cannot choose it). It also sets
`X-MM-Entrance` (`public` | `storefront` | `admin` | `scheduler`) on every upstream request,
overwriting anything a caller sent: the Core API uses it to pick the Telegram OIDC redirect origin
(`WEB_PUBLIC_ORIGIN` vs `ADMIN_PUBLIC_ORIGIN`) and to bind browser sessions to the entrance they
were created on. Request bodies are streamed unchanged,
so ADR 0003 signatures still verify. The path and query are re-serialised by the WHATWG URL
parser, so a signed URL must already be in canonical form (the internal routes take no query
string; keep it that way or sign the normalised URL).

`CoreApiContainer` is a Durable Object that starts the image (`images.api`) with the gateway's
secrets and plain variables as the container environment, waits for `/api/v1/health`, and
forwards; while the process stays up, requests skip the probe, and an exit (rollout, host move,
crash) is noticed through `monitor()` or a failed forward and restarts it on the next request.
Requests are spread over `CONTAINER_INSTANCES` named instances; idle instances sleep
after `CONTAINER_SLEEP_AFTER_MINUTES`. Rollouts and host moves send `SIGTERM`; the API drains
in-flight requests (up to 25 s) and exits.

## Cron Trigger (`scheduled`)

Telegram Serverless has no scheduler ([docs](https://core.telegram.org/bots/serverless): only
update handlers, Mini App endpoints, `lib/` and `schema.js`), so the order-notification outbox
([ADR 0008](../../architecture/0008-order-notification-outbox.md)) is drained here. Deployed modes
(`staging`, `production`) declare `triggers.scheduled({ schedule: '* * * * *' })` (every minute,
UTC); local development has no cron.

Each tick (`src/scheduler.ts`):

1. Selects the signing key: the `SERVICE_AUTH_KEYS` entry whose id is `SCHEDULER_SERVICE_KEY_ID`
   (default `scheduler`). Missing, unknown or shorter than 32 bytes: logs a non-sensitive error
   and does nothing (fail closed).
2. Runs `drainOrderNotifications` from `services/telegram/tgcloud/lib/` (the same code the bot
   ships; customer status messages and staff group alerts) with the shared Core API client and
   transport. Core API requests go through the `scheduler` entrance in-process; Bot API calls use
   a minimal `sendMessage` adapter (`src/botApi.ts`) over `TELEGRAM_BOT_TOKEN`. Errors never
   contain the token, the Bot API URL or descriptions.
3. Every 15th minute (UTC minute 0/15/30/45 of `controller.scheduledTime`): signed
   `POST /api/v1/internal/maintenance/cleanup` (expired sessions, rate limits, nonces, OIDC
   states).

Failures are caught and logged as class/status/code only (no PII, token or secret), so one bad
tick never affects the next. Trade-offs: the per-minute cron keeps a container instance awake
around the clock; Cloudflare cron is best effort (late, skipped or overlapping ticks), which is
safe because the outbox lease and `attempt` fencing make concurrent drains correct.

The shared JS modules are bundled from `../telegram/tgcloud/lib/` (`allowJs` in `tsconfig.json`);
their only `sdk` import (`BotApiError`) is aliased to `src/telegramSdk.ts` in `vite.config.ts`,
`vitest.config.ts` and `tsconfig.json` `paths`.

## Configuration

Secrets (`bindings.secret()`, set per Worker; see infra/cloudflare/README.md): `DATABASE_URL`,
`SERVICE_AUTH_KEYS` (must contain a `scheduler:<secret>` entry for the cron, also accepted by the
Core API), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OIDC_CLIENT_SECRET`.

Plain variables: `SCHEDULER_SERVICE_KEY_ID` (`scheduler`; gateway only, not passed to the
container), `TELEGRAM_OIDC_ENABLED` (`true`), `TELEGRAM_OIDC_CLIENT_ID` (public client id),
`WEB_PUBLIC_ORIGIN` / `ADMIN_PUBLIC_ORIGIN` (`https://` + deploy-time `MM_WEB_HOSTNAME` /
`MM_ADMIN_HOSTNAME`, empty when unset), `TELEGRAM_BOT_ID` (`MM_TELEGRAM_BOT_ID`),
`CSRF_TRUSTED_ORIGINS` (`MM_CSRF_TRUSTED_ORIGINS`), plus the fixed values in
`cloudflare.config.ts`. Empty values are not passed to the container.

## Commands

```bash
pnpm --filter @muniramarket/api-gateway test          # routing policy, Bot API adapter, scheduler
pnpm --filter @muniramarket/api-gateway typecheck     # cf workers types + tsc
pnpm --filter @muniramarket/api-gateway exec cf build --mode staging   # bundle + image (Docker)
```

The image is built from `../api/Dockerfile` unless `CORE_API_IMAGE` names a digest-pinned
`registry.cloudflare.com/...@sha256:...` reference (required for production).
