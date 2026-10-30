# ADR 0007 — Browser sessions, CSRF and rate limiting

- Status: accepted
- Scope: `services/api` (sessions, CSRF, rate limits), `apps/web` (same-origin proxy)
- Builds on: ADR 0004 (Telegram identity verification)

## Context

The website and the Telegram Mini App need a signed-in state for the cart (and later checkout)
after the user's Telegram identity has been verified once (ADR 0004). The session must survive
page reloads, must not be readable by JavaScript, and must not open the API to cross-site request
forgery. Telegram user IDs supplied by a client are never trusted.

## Decision

### Same-origin API

Browsers never call Core API cross-origin. `apps/web` exposes a Route Handler at `/api/v1/[...path]`
that forwards to Core API (`API_INTERNAL_URL`, server-only) and refuses `/api/v1/internal/**`
(404). It forwards `cookie`, `x-csrf-token`, `origin` and appends `x-forwarded-for`, and returns
every `set-cookie`, `retry-after` and `cache-control` header. Consequences:

- the session cookie is first-party and host-only on the web origin;
- CSP can stay `connect-src 'self'`, and no CORS is needed for the browser;
- Core API sees the proxy as its peer. uvicorn runs with
  `--proxy-headers --forwarded-allow-ips=<proxy address>` so `request.client.host` is the real
  client for rate limiting; the API never parses `X-Forwarded-For` itself.

### Session tokens and storage

- Opaque token: `secrets.token_urlsafe(32)` (256 bits). The token is never stored or logged.
- Redis key `mm:sess:<sha256-hex(token)>` holds JSON
  `{user_id, telegram_user_id, csrf_token, auth_method, created_at, last_rotated_at}`.
- `SessionStore` protocol with `RedisSessionStore` (deployed) and `InMemorySessionStore`
  (`APP_ENV=test`), mirroring the replay-nonce store. One Redis client per process is shared by
  the nonce, session and rate-limit stores.
- Every authenticated request re-reads the user from the database, so blocking takes effect on
  the next request: blocked users get `403 account_blocked` and their session is deleted.

### Cookie

```
Set-Cookie: __Host-mm_session=<token>; Max-Age=<absolute remaining>; Path=/; HttpOnly; SameSite=Lax; Secure
```

- `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` (host-only). `Max-Age` is the remaining
  absolute lifetime.
- `SESSION_COOKIE_SECURE` defaults to `true`. With it the cookie is named `__Host-mm_session`;
  the `__Host-` prefix makes browsers reject the cookie unless it is `Secure`, has `Path=/` and no
  `Domain`, so a sibling subdomain cannot plant or overwrite it.
- `SESSION_COOKIE_SECURE=false` (cookie `mm_session`, no `Secure`) is accepted only when `APP_ENV`
  is `development` or `test`, for plain-HTTP local development. Settings validation refuses it in
  staging and production.

### `SameSite=Lax` and Telegram clients (known limitation)

`Lax` keeps the cookie off cross-site subresource and `POST` requests, which is the first line of
CSRF defence. Telegram's mobile and desktop apps open the Mini App in a webview whose top-level
document is our origin, so the cookie is first-party and works. **Telegram Web** (web.telegram.org)
embeds the Mini App in an `iframe`; there the cookie is third-party, and browsers may refuse to
store or send it (`Lax` cookies are not sent in cross-site iframes, and third-party cookie blocking
applies on top). Sign-in may therefore not persist in Telegram Web. This is accepted for this
phase: there is **no bearer-token fallback** (it would put a session secret within reach of
JavaScript). Users of Telegram Web can use the website directly.

### Lifetime and rotation

- Idle expiry `SESSION_IDLE_TTL_SECONDS` (default 7 days), sliding: each authenticated request
  resets the Redis TTL, capped at the remaining absolute lifetime.
- Absolute lifetime `SESSION_ABSOLUTE_TTL_SECONDS` (default 30 days from `created_at`), never
  extended by use or rotation.
- Every login issues a new token and deletes the session presented in the request cookie,
  whoever it belonged to (anti-fixation).
- A request whose session was last rotated more than `SESSION_ROTATE_AFTER_SECONDS` ago (default
  24 h) gets a new token through `Set-Cookie`; the old key is deleted in the same `MULTI`
  transaction and the CSRF token is kept. Rotation cookies are attached to every response,
  including error responses, so a route that fails after the rotation does not sign the user out.
  Two requests racing on the old token at the moment of rotation can see one `401`; a client that
  gets an unexpected `401` while signed in should re-check `GET /auth/session` once before showing
  the signed-out state.
- `POST /auth/logout` deletes the session and expires the cookie (`204`, idempotent).

### CSRF

Two independent checks for `POST`, `PUT`, `PATCH`, `DELETE`:

1. **Origin check.** The `Origin` header, or if absent the origin of `Referer`, must be in
   `CSRF_TRUSTED_ORIGINS` (comma list, normalised to `scheme://host[:port]`; `*` rejected;
   `https://` required in staging and production). With neither header the request is rejected in
   staging and production and allowed in development and test. Login endpoints, which have no
   session yet, enforce this check too (login CSRF), and so does logout.
2. **Synchronizer token** bound to the session: `csrf_token = secrets.token_urlsafe(32)`, returned
   in the JSON body of every login and of `GET /auth/session`. The client keeps it in memory only
   and sends it as `X-CSRF-Token`; Core API compares it with `hmac.compare_digest`. Logout requires
   it whenever a live session is presented.

Any failure is `403 csrf_failed`.

### Rate limiting

Fixed window per `(scope, subject)`: `INCR` and `EXPIRE <window> NX` in one `MULTI` transaction on
`mm:rl:<scope>:<ip|user_id>:<window_start>`; `InMemoryRateLimiter` in tests. Exceeding a limit
returns `429 rate_limited` with `Retry-After` (seconds to the end of the window).

| Scope          | Endpoints                           | Limit      | Key     |
| -------------- | ----------------------------------- | ---------- | ------- |
| `auth_login`   | init-data and login-widget sign-in  | 10 / 60 s  | IP      |
| `auth_session` | `GET /auth/session`, `POST /logout` | 60 / 60 s  | IP      |
| `cart_read`    | cart reads                          | 120 / 60 s | user id |
| `cart_write`   | cart writes                         | 60 / 60 s  | user id |

### Fail closed

If Redis errors while reading or writing sessions or rate-limit counters, the request fails with
`503 service_unavailable`; it is never served unauthenticated or unlimited. Logs record only that
the store was unavailable: tokens, CSRF tokens, token hashes, cookies and `initData` are never
logged. Responses under `/api/v1/auth/` and every response carrying a session cookie are
`Cache-Control: no-store`.

### Telegram Login Widget (website, feature flag)

`TELEGRAM_LOGIN_WIDGET_ENABLED` (default `false`) enables `POST /auth/telegram/login-widget`;
when off it answers `404 feature_disabled`, and `GET /auth/config` tells the website whether to
render the widget and with which `TELEGRAM_BOT_USERNAME`. Enabling it requires
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (settings validation), because the widget is
signed with `HMAC-SHA256(key = SHA-256(bot_token))` over the sorted `key=value` lines of every
field except `hash`. Only `id`, `first_name`, `last_name`, `username`, `photo_url`, `auth_date` and
`hash` are accepted; `auth_date` may be at most `TELEGRAM_LOGIN_MAX_AGE_SECONDS` (default 86400)
old and at most 60 s in the future. Note that configuring the bot token also switches Mini App
`initData` verification from Ed25519 to the HMAC method (ADR 0004).

## Consequences

- Without credentials the website still browses the catalog; cart actions prompt the user to
  sign in through the Mini App, or with the widget when the flag is on.
- Redis becomes a hard dependency for signed-in traffic (it already was for internal routes).
- Clients must handle `401 session_required` (signed out), `403 csrf_failed` (refetch
  `GET /auth/session` for a fresh token), `403 account_blocked`, `429` with `Retry-After`, and
  `503`.
