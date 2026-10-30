# ADR 0003 — Service-to-service authentication (Telegram Serverless → Core API)

- Status: accepted (foundation)
- Scope: `services/telegram` (signer) and `services/api` (verifier)

## Context

Telegram Serverless endpoints and handlers run on Telegram's infrastructure. They need to call the
Core API on behalf of a Telegram user whose identity the platform has already verified
(`ctx.initData.user` in endpoints, `message.from` in handlers). The Core API must be able to tell a
genuine Serverless request apart from anything else on the internet, and must never accept a
Telegram user ID that a browser or Mini App client supplied directly.

## Decision

Every internal request is signed with HMAC-SHA256 using a shared secret identified by a key ID.
Internal routes live under `/api/v1/internal/` and accept **only** signed requests. The acting
Telegram user is part of the signed material, so it cannot be swapped in transit.

### Headers

| Header           | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| `X-MM-Key-Id`    | Key identifier, `[A-Za-z0-9_-]{1,32}`. Allows rotation with two active keys.     |
| `X-MM-Timestamp` | Unix time in seconds (integer, decimal).                                         |
| `X-MM-Nonce`     | Random, `[A-Za-z0-9_-]{16,64}`. Unique per request.                              |
| `X-MM-Actor`     | `tg:<telegram_user_id>` when acting for a user, otherwise empty string / absent. |
| `X-MM-Signature` | Lowercase hex HMAC-SHA256 of the canonical string.                               |

### Canonical string

Eight lines joined by `\n` (0x0A), no trailing newline:

```
MM-SVC-V1
<key_id>
<timestamp>
<nonce>
<HTTP method, uppercase>
<request path including query string, exactly as sent, e.g. /api/v1/internal/x?a=1>
<actor, or empty string>
<lowercase hex SHA-256 of the raw request body bytes; empty body => SHA-256 of "">
```

`signature = hex(HMAC_SHA256(key = secret_utf8_bytes, msg = canonical_utf8_bytes))`

### Verification rules (Core API)

1. All five headers present and well-formed (actor may be empty), otherwise `401`.
2. `key_id` must exist in the configured key set, otherwise `401`.
3. `|now - timestamp| <= 300` seconds, otherwise `401`.
4. Signature compared in constant time, otherwise `401`.
5. Nonce must not have been seen within the last 660 seconds, i.e. twice the skew window plus a
   margin (replay store; Redis in deployed environments, in-memory in tests), otherwise `401`.
   The nonce is recorded only after the signature is valid.
6. Error responses never reveal which check failed.
7. Header shape, key ID and timestamp are checked before the body is read, and bodies above
   64 KiB are rejected with `413`, so unauthenticated callers cannot make the API buffer large
   payloads.

Each environment (development, staging, production) uses its own key IDs and secrets, because the
canonical string does not bind the host or environment.

Secrets are at least 32 bytes, configured only through the environment
(`SERVICE_AUTH_KEYS`, format `key_id:secret[,key_id:secret]`) on the Core API side.

### Test vector

Both implementations must reproduce this exactly (the secret is a test value, never used anywhere
else):

| Field        | Value                                                              |
| ------------ | ------------------------------------------------------------------ |
| secret       | `test-only-secret-not-for-production-0001`                         |
| key_id       | `test-key`                                                         |
| timestamp    | `1767225600`                                                       |
| nonce        | `n0nce-abc123-0001`                                                |
| method       | `POST`                                                             |
| path         | `/api/v1/internal/telegram/session`                                |
| actor        | `tg:123456789`                                                     |
| body         | `{"telegram_user_id":123456789}`                                   |
| body SHA-256 | `c4c0f3c754b25d079cc6a56808b61d6967e6eb03feb9f39cb9ff6f5d9c8a12ec` |
| signature    | `4f759f2ee938c855bca8f77302d9ccd54ae37cbd52d0942eb9b4dee95c8a43fc` |

## Consequences

- The Serverless runtime only exposes `sdk` and project modules; WebCrypto is not documented
  there. The signer therefore ships a dependency-free SHA-256/HMAC implementation in
  `services/telegram/tgcloud/lib/`, tested against Node's `crypto` and the vector above.
- **Open item:** Telegram Serverless documents no secret store or environment variables. Until
  one is confirmed, the signer reads its key from the bot's private Serverless database
  (`service_config` table) and fails closed when the row is missing. The secret is provisioned by
  an operator outside the repository. See `services/telegram/README.md`.
- A compromised Serverless secret lets an attacker act as any Telegram user against internal
  routes. Mitigations: short skew window, replay store, key rotation, internal routes limited to
  the minimum the bot needs, and rate limiting (later phase).
