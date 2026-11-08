# Core API gateway (Cloudflare Worker → Neon Function)

The only way into the Core API Neon Function `coreapi` ([services/core-api-function](../core-api-function)).
Design: [ADR 0016](../../architecture/0016-core-api-on-neon-functions.md) (updates
[ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md)); operations:
[infra/cloudflare](../../infra/cloudflare/README.md). Runs on the Workers Free plan: no
Containers, Durable Objects or image registry.

| Entrance                          | Reached by                                   | Allowed                                                                                                                     |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `default.fetch` (public hostname) | Telegram Serverless, uptime checks           | `GET /api/v1/health[/ready]`, `POST /api/v1/internal/telegram/session`, `POST /api/v1/internal/telegram/staff-chat/connect` |
| `StorefrontApi` entrypoint        | web Worker service binding `CORE_API`        | everything except `admin/**` and `internal/**`                                                                              |
| `AdminApi` entrypoint             | admin Worker service binding `CORE_API`      | `admin/**`, `auth/config`, `auth/session`, `auth/logout`, `auth/telegram/oidc/start`, `auth/telegram/oidc/callback`         |
| `scheduler` (internal only)       | this Worker's own Cron Trigger (`scheduled`) | `POST internal/scheduler/notifications/drain`, `POST internal/maintenance/cleanup`                                          |

`src/routing.ts` holds the policy (pure, unit-tested): path normalisation (encoded `..`/`/`
refused), the allow-lists, which headers reach the Function, and the upstream URL (fixed origin +
path + query, so a request path can never change the authority). The gateway always writes
`X-Forwarded-For` itself (public: `CF-Connecting-IP`; bindings: the single IP the app forwarded),
`X-Request-ID` (public and scheduler callers cannot choose it), `X-MM-Entrance` and
`X-MM-Gateway-Secret`; whatever a caller sent for those is dropped by the allow-list first.

`src/forward.ts` sends the request to `CORE_API_FUNCTION_ORIGIN` with
`X-MM-Gateway-Secret: CORE_API_FUNCTION_SECRET`, `redirect: 'manual'` (a redirect is refused with
`502`, the secret never follows it), a 20 s timeout (`504`; the scheduler entrance waits up to
60 s for a drain) and `502` on network errors. The one redirect passed on is the end of the
Telegram OIDC sign-in (`GET auth/telegram/oidc/callback` on the storefront and admin entrances):
exactly `303` with a same-origin, path-absolute `Location`, plus its cookies (ADR 0014). Every
response, including the gateway's own errors, carries `X-Request-ID` (the app proxy's id on the
binding entrances), and every gateway log line has it as `request_id`.

Timeout budget (each layer gives up before the one outside it): Function `pg` connect 10 s and
Telegram HTTP 10 s, gateway 20 s, admin proxy 25 s. A missing or malformed origin/secret is `503`
without any upstream call. Request bodies are streamed unchanged, so ADR 0003 signatures still
verify.

## Cron Trigger (`scheduled`)

Deployed modes declare `triggers.scheduled({ schedule: '* * * * *' })`. On the Free plan an
invocation gets 10 ms of CPU, so a tick only signs (ADR 0003, empty actor, key id
`SCHEDULER_SERVICE_KEY_ID`, secret `SCHEDULER_SERVICE_SECRET`) and forwards:

1. every minute: `POST /api/v1/internal/scheduler/notifications/drain`. The Function claims the
   notification outbox, sends the Telegram messages and reports outcomes next to Postgres; the
   response carries counts only.
2. every 15th minute (UTC minute 0/15/30/45 of `controller.scheduledTime`): `POST
/api/v1/internal/maintenance/cleanup` (expired sessions, rate limits, nonces, OIDC states).

Failures are caught and logged as class/status/code only, so one bad tick never affects the next.
Cron is best effort (late, skipped or overlapping ticks); the outbox lease and `attempt` fencing
keep delivery at-least-once without double-reporting, and a message whose outcome was not reported
is claimed again after its 60 s lease.

The signer is reused from `../telegram/tgcloud/lib/coreApi/` (dependency-free, `allowJs`).

## Configuration

Secrets (`bindings.secret()`): `CORE_API_FUNCTION_ORIGIN` (the Function's `invocation_url`),
`CORE_API_FUNCTION_SECRET` (same value as on the Function), `SCHEDULER_SERVICE_SECRET` (the
Function's `SERVICE_AUTH_KEYS` holds `scheduler:<same value>`). Plain: `SCHEDULER_SERVICE_KEY_ID`
(`scheduler`). Everything else (Telegram, OIDC, CSRF origins) is Function configuration.

## Commands

```bash
pnpm --filter @muniramarket/api-gateway test          # routing, forwarding, scheduler
pnpm --filter @muniramarket/api-gateway typecheck     # cf workers types + tsc
pnpm --filter @muniramarket/api-gateway exec cf build --mode staging   # Worker bundle only
```
