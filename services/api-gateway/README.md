# Core API gateway (Cloudflare Worker + Container)

The only way into the FastAPI container on Cloudflare Containers. Design:
[ADR 0011](../../architecture/0011-cloudflare-neon-deployment.md); operations:
[infra/cloudflare](../../infra/cloudflare/README.md).

| Entrance                          | Reached by                              | Allowed                                                                                |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `default.fetch` (public hostname) | Telegram Serverless, uptime checks      | `GET /api/v1/health[/ready]`, `POST /api/v1/internal/telegram/**`                      |
| `StorefrontApi` entrypoint        | web Worker service binding `CORE_API`   | everything except `admin/**` and `internal/**`                                         |
| `AdminApi` entrypoint             | admin Worker service binding `CORE_API` | `admin/**`, `auth/config`, `auth/session`, `auth/logout`, `auth/telegram/login-widget` |

`src/routing.ts` holds the policy (pure, unit-tested): path normalisation (encoded `..`/`/`
refused), the allow-lists, and which headers reach the container. The gateway always writes
`X-Forwarded-For` itself (public: `CF-Connecting-IP`; bindings: the single IP the app forwarded)
and sets `X-Request-ID` (public callers cannot choose it). Request bodies are streamed unchanged,
so ADR 0003 signatures still verify.

`CoreApiContainer` is a Durable Object that starts the image (`images.api`) with the gateway's
secrets and plain variables as the container environment, waits for `/api/v1/health`, and
forwards. Requests are spread over `CONTAINER_INSTANCES` named instances; idle instances sleep
after `CONTAINER_SLEEP_AFTER_MINUTES`. Rollouts and host moves send `SIGTERM`; the API drains
in-flight requests (up to 25 s) and exits.

```bash
pnpm --filter @muniramarket/api-gateway test          # routing policy
pnpm --filter @muniramarket/api-gateway typecheck     # cf workers types + tsc
pnpm --filter @muniramarket/api-gateway exec cf build --mode staging   # bundle + image (Docker)
```

The image is built from `../api/Dockerfile` unless `CORE_API_IMAGE` names a digest-pinned
`registry.cloudflare.com/...@sha256:...` reference (required for production).
