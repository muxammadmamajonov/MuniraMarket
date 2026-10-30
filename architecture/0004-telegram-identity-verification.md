# ADR 0004 — Telegram identity verification in Core API

- Status: accepted

## Decision

Core API never trusts a Telegram user ID sent by a client. Identity arrives through one of:

1. **Signed service request** from Telegram Serverless (ADR 0003), whose `X-MM-Actor` comes from
   platform-verified data.
2. **Raw Mini App `initData`** posted to `POST /api/v1/auth/telegram/init-data` and verified
   server-side behind a `TelegramIdentityVerifier` interface:
   - default: Ed25519 "third-party" validation with Telegram's published public key and the bot ID,
     so Core API does not need the bot token;
   - optional: the HMAC-SHA256 method with the bot token, enabled only when a token is configured.
     Both reject tampered fields, duplicate keys, missing users, and `auth_date` that is too old or in
     the future.

Web login with the Telegram Login flow and the HTTP-only session cookie are implemented in the
catalog/cart phase on top of the same verifier interface.

Update (catalog/cart phase): sessions, CSRF, rate limits and the feature-flagged Telegram Login
Widget are specified in [ADR 0007](0007-browser-sessions-csrf.md). Verification failures on the
public sign-in endpoints now return `401 invalid_telegram_auth`.
