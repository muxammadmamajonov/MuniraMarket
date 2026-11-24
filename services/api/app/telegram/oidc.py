"""Telegram OpenID Connect sign-in for browsers (ADR 0014).

Authorization Code flow with PKCE (S256), run entirely by the Core API:

1. ``start`` creates a one-time ``state``, a ``nonce`` and a PKCE ``code_verifier`` (stored in
   PostgreSQL, see :class:`OidcStateStore`) and sends the browser to Telegram's authorization
   endpoint with the redirect URI registered for that entrance's origin.
2. Telegram redirects back to ``/api/v1/auth/telegram/oidc/callback?code&state``. The state is
   consumed exactly once, the code is exchanged at the token endpoint with HTTP Basic client
   authentication (the client secret never leaves the server) and the PKCE verifier, and the
   returned ``id_token`` is verified here: RS256 signature against Telegram's JWKS, ``iss``,
   ``aud``, ``exp``, ``iat`` and ``nonce``.

Endpoints and claims follow https://core.telegram.org/bots/telegram-login and the discovery
document https://oauth.telegram.org/.well-known/openid-configuration. The numeric Telegram user id
is the ``id`` claim (``profile`` scope); ``sub`` is a different, opaque identifier and is not used.

Only RS256 is accepted (Telegram's default; the bot must not switch the Login Widget's signing
algorithm in BotFather). There is deliberately no ``alg`` negotiation: ``none``, HMAC and every
other algorithm are refused before any key is looked at.
"""

import base64
import binascii
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol
from urllib.parse import urlencode

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.core.clock import Clock
from app.telegram.identity import VerifiedTelegramIdentity

logger = logging.getLogger("app.telegram.oidc")

CALLBACK_PATH: Final = "/api/v1/auth/telegram/oidc/callback"
SCOPE: Final = "openid profile"
ALGORITHM: Final = "RS256"
# Clock skew tolerated on ``exp`` and ``iat``.
LEEWAY_SECONDS: Final = 60
HTTP_TIMEOUT_SECONDS: Final = 10.0
JWKS_TTL_SECONDS: Final = 3600
# An unknown ``kid`` refetches the key set at most this often (key rotation, not a DoS lever).
JWKS_REFRESH_MIN_INTERVAL_SECONDS: Final = 60
MAX_ID_TOKEN_BYTES: Final = 16 * 1024

_B64URL_RE = re.compile(r"[A-Za-z0-9_-]+")
_KID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_CODE_RE = re.compile(r"[A-Za-z0-9._~+/=-]{1,1024}")
_TELEGRAM_USER_ID_RE = re.compile(r"[1-9][0-9]{0,15}")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_NAME_LENGTH = 255
_MAX_USERNAME_LENGTH = 64


class OidcError(Exception):
    """Sign-in failed. ``reason`` is a short, non-sensitive log label (never token content)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class OidcEndpoints:
    issuer: str

    @property
    def authorization(self) -> str:
        return f"{self.issuer}/auth"

    @property
    def token(self) -> str:
        return f"{self.issuer}/token"

    @property
    def jwks(self) -> str:
        return f"{self.issuer}/.well-known/jwks.json"


# --- PKCE, state, nonce ---------------------------------------------------------------------------


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    if not _B64URL_RE.fullmatch(text):
        raise OidcError("token_malformed")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise OidcError("token_malformed") from None


def new_code_verifier() -> str:
    """RFC 7636: 43-128 characters; 64 random bytes give 86."""
    return secrets.token_urlsafe(64)


def code_challenge(verifier: str) -> str:
    return b64url_encode(hashlib.sha256(verifier.encode("ascii")).digest())


def new_secret_value() -> str:
    """``state``, ``nonce`` and the browser binding value: 256 random bits each."""
    return secrets.token_urlsafe(32)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def is_plausible_code(code: str) -> bool:
    return _CODE_RE.fullmatch(code) is not None


def authorization_url(
    endpoints: OidcEndpoints,
    *,
    client_id: int,
    redirect_uri: str,
    state: str,
    nonce: str,
    verifier: str,
) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": str(client_id),
            "redirect_uri": redirect_uri,
            "scope": SCOPE,
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge(verifier),
            "code_challenge_method": "S256",
        }
    )
    return f"{endpoints.authorization}?{query}"


# --- token endpoint and JWKS ----------------------------------------------------------------------


class OidcProvider(Protocol):
    """The two network calls of the flow; a fake replaces it in tests."""

    async def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> str:
        """Return the ``id_token`` for ``code`` or raise :class:`OidcError`."""
        ...

    async def signing_key(self, kid: str) -> rsa.RSAPublicKey:
        """The RS256 key with id ``kid`` from the provider's JWKS, or :class:`OidcError`."""
        ...


def rsa_key_from_jwk(jwk: Mapping[str, Any]) -> rsa.RSAPublicKey:
    if jwk.get("kty") != "RSA" or jwk.get("alg", ALGORITHM) != ALGORITHM:
        raise OidcError("jwk_not_rs256")
    if jwk.get("use", "sig") != "sig":
        raise OidcError("jwk_not_signing")
    n, e = jwk.get("n"), jwk.get("e")
    if not isinstance(n, str) or not isinstance(e, str):
        raise OidcError("jwk_malformed")
    modulus = int.from_bytes(b64url_decode(n), "big")
    exponent = int.from_bytes(b64url_decode(e), "big")
    if modulus.bit_length() < 2048:
        raise OidcError("jwk_too_small")
    return rsa.RSAPublicNumbers(exponent, modulus).public_key()


class HttpOidcProvider:
    """Talks to Telegram over HTTPS (httpx). Responses are never logged: they hold tokens."""

    def __init__(
        self,
        *,
        endpoints: OidcEndpoints,
        client_id: int,
        client_secret: str,
        clock: Clock = time.time,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoints = endpoints
        self._client_id = str(client_id)
        self._client_secret = client_secret
        self._clock = clock
        self._transport = transport
        self._keys: dict[str, rsa.RSAPublicKey] = {}
        self._fetched_at: float | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=self._transport,
            timeout=HTTP_TIMEOUT_SECONDS,
            follow_redirects=False,
            headers={"accept": "application/json", "user-agent": "muniramarket-core-api"},
        )

    async def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> str:
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self._client_id,
            "code_verifier": code_verifier,
        }
        try:
            async with self._client() as client:
                response = await client.post(
                    self._endpoints.token,
                    data=form,
                    auth=httpx.BasicAuth(self._client_id, self._client_secret),
                )
        except httpx.HTTPError:
            raise OidcError("token_endpoint_unreachable") from None
        if response.status_code != 200:
            raise OidcError(f"token_endpoint_{response.status_code}")
        try:
            body = response.json()
        except ValueError:
            raise OidcError("token_response_not_json") from None
        id_token = body.get("id_token") if isinstance(body, dict) else None
        if not isinstance(id_token, str) or not id_token:
            raise OidcError("token_response_without_id_token")
        return id_token

    async def _refresh(self) -> None:
        try:
            async with self._client() as client:
                response = await client.get(self._endpoints.jwks)
        except httpx.HTTPError:
            raise OidcError("jwks_unreachable") from None
        if response.status_code != 200:
            raise OidcError(f"jwks_{response.status_code}")
        try:
            document = response.json()
        except ValueError:
            raise OidcError("jwks_not_json") from None
        raw_keys = document.get("keys") if isinstance(document, dict) else None
        if not isinstance(raw_keys, list):
            raise OidcError("jwks_malformed")
        keys: dict[str, rsa.RSAPublicKey] = {}
        for jwk in raw_keys:
            if not isinstance(jwk, dict) or jwk.get("kty") != "RSA":
                continue  # Telegram also publishes an ES256 key; only RS256 is accepted here.
            kid = jwk.get("kid")
            if not isinstance(kid, str) or not _KID_RE.fullmatch(kid):
                continue
            try:
                keys[kid] = rsa_key_from_jwk(jwk)
            except OidcError:
                continue
        self._keys = keys
        self._fetched_at = self._clock()

    async def signing_key(self, kid: str) -> rsa.RSAPublicKey:
        now = self._clock()
        stale = self._fetched_at is None or now - self._fetched_at > JWKS_TTL_SECONDS
        may_refresh = self._fetched_at is None or (
            now - self._fetched_at > JWKS_REFRESH_MIN_INTERVAL_SECONDS
        )
        if stale or (kid not in self._keys and may_refresh):
            await self._refresh()
        key = self._keys.get(kid)
        if key is None:
            raise OidcError("unknown_kid")
        return key


# --- id_token verification ------------------------------------------------------------------------


def _json_segment(segment: str) -> dict[str, Any]:
    try:
        value = json.loads(b64url_decode(segment))
    except (UnicodeDecodeError, ValueError):
        raise OidcError("token_malformed") from None
    if not isinstance(value, dict):
        raise OidcError("token_malformed")
    return value


def _int_claim(claims: Mapping[str, Any], name: str) -> int:
    value = claims.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise OidcError(f"claim_{name}_invalid")
    return value


def _telegram_user_id_claim(claims: Mapping[str, Any]) -> int:
    """Accept Telegram's numeric or canonical decimal-string OIDC ``id`` claim."""
    value = claims.get("id")
    if isinstance(value, bool):
        raise OidcError("claim_id_invalid")
    if isinstance(value, int) and 0 < value <= _MAX_SAFE_INTEGER:
        return value
    if isinstance(value, str) and _TELEGRAM_USER_ID_RE.fullmatch(value):
        user_id = int(value)
        if user_id <= _MAX_SAFE_INTEGER:
            return user_id
    raise OidcError("claim_id_invalid")


def _optional_text(claims: Mapping[str, Any], name: str, max_length: int) -> str | None:
    value = claims.get(name)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped[:max_length] if stripped else None


def unverified_kid(id_token: str) -> str:
    """The ``kid`` of an RS256 token. Refuses every other algorithm up front."""
    if len(id_token) > MAX_ID_TOKEN_BYTES or id_token.count(".") != 2:
        raise OidcError("token_malformed")
    header = _json_segment(id_token.split(".", 1)[0])
    if header.get("alg") != ALGORITHM:
        raise OidcError("alg_not_rs256")
    kid = header.get("kid")
    if not isinstance(kid, str) or not _KID_RE.fullmatch(kid):
        raise OidcError("kid_missing")
    return kid


def verify_id_token(
    id_token: str,
    *,
    key: rsa.RSAPublicKey,
    issuer: str,
    client_id: int,
    nonce: str,
    now: float,
) -> VerifiedTelegramIdentity:
    """Check signature and claims; return the Telegram identity or raise :class:`OidcError`."""
    unverified_kid(id_token)
    header_b64, payload_b64, signature_b64 = id_token.split(".")
    signature = b64url_decode(signature_b64)
    try:
        key.verify(
            signature,
            f"{header_b64}.{payload_b64}".encode("ascii"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature:
        raise OidcError("bad_signature") from None
    claims = _json_segment(payload_b64)

    if claims.get("iss") != issuer:
        raise OidcError("iss_mismatch")
    audience = claims.get("aud")
    expected_audience = str(client_id)
    audiences = audience if isinstance(audience, list) else [audience]
    if not any(str(item) == expected_audience for item in audiences if item is not None):
        raise OidcError("aud_mismatch")
    if isinstance(audience, list) and len(audience) > 1:
        authorized_party = claims.get("azp")
        if authorized_party is None or str(authorized_party) != expected_audience:
            raise OidcError("azp_mismatch")
    if _int_claim(claims, "exp") <= now - LEEWAY_SECONDS:
        raise OidcError("expired")
    issued_at = _int_claim(claims, "iat")
    if issued_at > now + LEEWAY_SECONDS:
        raise OidcError("iat_in_future")
    received_nonce = claims.get("nonce")
    if not isinstance(received_nonce, str) or not hmac.compare_digest(
        received_nonce.encode("utf-8"), nonce.encode("utf-8")
    ):
        raise OidcError("nonce_mismatch")

    telegram_user_id = _telegram_user_id_claim(claims)
    first_name = _optional_text(claims, "given_name", _MAX_NAME_LENGTH) or _optional_text(
        claims, "name", _MAX_NAME_LENGTH
    )
    if first_name is None:
        raise OidcError("claim_name_missing")
    return VerifiedTelegramIdentity(
        telegram_user_id=telegram_user_id,
        first_name=first_name,
        last_name=_optional_text(claims, "family_name", _MAX_NAME_LENGTH),
        username=_optional_text(claims, "preferred_username", _MAX_USERNAME_LENGTH),
        language_code=None,
        auth_date=issued_at,
    )


@dataclass(frozen=True, slots=True)
class OidcClient:
    """Everything the routes need: configuration plus the provider (network or fake)."""

    endpoints: OidcEndpoints
    client_id: int
    provider: OidcProvider
    state_ttl_seconds: int

    async def identity_for(
        self, *, code: str, redirect_uri: str, code_verifier: str, nonce: str, now: float
    ) -> VerifiedTelegramIdentity:
        id_token = await self.provider.exchange_code(
            code=code, redirect_uri=redirect_uri, code_verifier=code_verifier
        )
        key = await self.provider.signing_key(unverified_kid(id_token))
        return verify_id_token(
            id_token,
            key=key,
            issuer=self.endpoints.issuer,
            client_id=self.client_id,
            nonce=nonce,
            now=now,
        )
