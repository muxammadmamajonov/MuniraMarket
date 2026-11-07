# ADR 0014 — One bot, Telegram OIDC browser sign-in

- Status: accepted
- Supersedes: the Telegram Login Widget parts of [0007](0007-browser-sessions-csrf.md) and the second admin bot of PR #12

## Context

The website and the admin sign in with Telegram outside the Mini App. PR #12 added a second bot
for the admin because the classic Login Widget binds one bot to one domain. Telegram now offers
“Log in with Telegram” as standard OpenID Connect (https://core.telegram.org/bots/telegram-login,
discovery at https://oauth.telegram.org/.well-known/openid-configuration): Authorization Code flow
with PKCE, several registered redirect URLs per bot, `id_token` signed RS256 by default. The
admin is not a separate identity: it is the same Telegram user, and Core API decides `operator`/
`admin` per request.

## Decision

- **One bot** (`9038491407`), which is also the OIDC client id. `ADMIN_TELEGRAM_BOT_TOKEN`,
  `MM_ADMIN_TELEGRAM_BOT_USERNAME` and the Login Widget (`/auth/telegram/login-widget`,
  `TELEGRAM_LOGIN_WIDGET_ENABLED`, `TELEGRAM_BOT_USERNAME`) are removed.
- **Registered redirect URIs** (BotFather → Login Widget): `https://muniramarket.uz/api/v1/auth/telegram/oidc/callback`
  and `https://admin.muniramarket.uz/api/v1/auth/telegram/oidc/callback`. Production deploy
  validation pins these two hostnames and the bot id.
- **Server-side flow, redirect mode** (no Telegram JavaScript, no popup):
  1. `POST /auth/telegram/oidc/start` (trusted `Origin`, rate-limited) creates `state`, `nonce` and
     a PKCE verifier, stores `sha256(state)` with the verifier, nonce, entrance and a sanitised
     same-origin `return_to` in `oidc_login_states` (10 min, ADR 0013), sets a `__Host-mm_oidc`
     binding cookie (`HttpOnly; Secure; SameSite=Lax`, hash stored) and returns the
     authorization URL (`scope=openid profile`, `code_challenge_method=S256`).
  2. The browser navigates there; Telegram redirects to the callback on the same origin.
  3. `GET /auth/telegram/oidc/callback` consumes the state exactly once, requires the binding
     cookie (login-CSRF: a callback URL opened in another browser fails), requires the same
     entrance, exchanges the code at `https://oauth.telegram.org/token` with HTTP Basic client
     authentication and the PKCE verifier and the exact redirect URI, fetches the JWKS (cached 1 h,
     refreshed on an unknown `kid` at most once a minute) and verifies the `id_token`: header `alg`
     must be `RS256` (everything else, including `none`, is refused before key lookup), RSA ≥ 2048
     signature, `iss == https://oauth.telegram.org`, `aud` contains the client id (`azp` when
     several), `exp`/`iat` with 60 s leeway, `nonce` equal (constant time). The Telegram user id is
     the `id` claim (`sub` is a different opaque value). It then signs in exactly like `initData`
     (upsert, anti-fixation, blocked users refused) and answers `303` to `return_to`; every
     failure answers `303` to `/<locale>/auth/telegram?status=failed|cancelled|blocked|unavailable`.
- **Client secret**: only a gateway Worker secret (`TELEGRAM_OIDC_CLIENT_SECRET`), passed to the
  container; it is used only in the server-to-server token request and never reaches a browser,
  a log or the repository. The issuer can only be overridden in development/test (E2E fake).
- **Entrance binding**: the gateway sets `X-MM-Entrance` (`storefront`/`admin`) on every request
  (browsers cannot set it; the app proxies forward an allow-list and, without a gateway in local
  development, set their own value). Sessions record their entrance. Back-office routes accept
  only `auth_method = telegram_oidc` **and** `entrance = admin`; a Mini App or storefront session is
  never an admin session, whatever the user's role.
- **CSP/COOP**: the widget's `script-src https://telegram.org` and `frame-src
https://oauth.telegram.org` are removed (nothing from Telegram is loaded). Pages send
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`, the value Telegram's documentation names
  as compatible should the popup library ever be used; `same-origin` would block it.
- **Mini App** `initData` sign-in is unchanged.
- **Other providers**: Neon Managed Auth has no generic Telegram OAuth provider, so Telegram stays
  a first-party provider here. Google and Apple are future, separate providers: the identity of a
  user stays the Telegram id today; linking another provider will require a fresh, verified sign-in
  on **both** sides in one session and will never merge accounts by e-mail or name. No Google or
  Apple login exists until real OAuth credentials are configured.

## Consequences

- One bot token, one client secret; no domain-per-bot constraint.
- The flow depends on Telegram's token endpoint and JWKS being reachable from the container.
- If the bot's signing algorithm is switched away from RS256 in BotFather, sign-in fails closed.
