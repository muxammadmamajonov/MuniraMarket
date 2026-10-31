"""Verify Neon Auth (Managed Better Auth) session JWTs.

A browser signed in with Neon Auth gets a short-lived JWT (``authClient.token()``) and sends it as
``Authorization: Bearer``. The token is EdDSA (Ed25519) signed; the public keys are published at
``NEON_AUTH_JWKS_URL`` and the issuer is the origin of ``NEON_AUTH_BASE_URL``. A valid token
proves identity only (``sub``); it grants no role in this API, and signing out does not revoke a
token already issued, so keep them short-lived.

The JWKS is fetched lazily and cached; an unknown ``kid`` triggers one refresh (key rotation) at
most every :data:`MIN_REFRESH_SECONDS`.
"""

import asyncio
import base64
import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

JWKS_TTL_SECONDS: Final = 600
MIN_REFRESH_SECONDS: Final = 30
FETCH_TIMEOUT_SECONDS: Final = 5
MAX_JWKS_BYTES: Final = 64 * 1024
LEEWAY_SECONDS: Final = 30


class NeonAuthError(Exception):
    """The token is missing, malformed, expired, or not signed by this branch's Neon Auth."""


@dataclass(frozen=True, slots=True)
class NeonIdentity:
    user_id: str
    email: str | None
    name: str | None
    expires_at: int


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _fetch_jwks(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"accept": "application/json"})  # noqa: S310
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:  # noqa: S310
        body = response.read(MAX_JWKS_BYTES + 1)
    if len(body) > MAX_JWKS_BYTES:
        raise NeonAuthError("JWKS response too large")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise NeonAuthError("JWKS is not an object")
    return data


def _ed25519_keys(jwks: dict[str, Any]) -> dict[str, Ed25519PublicKey]:
    keys: dict[str, Ed25519PublicKey] = {}
    for jwk in jwks.get("keys", []):
        if (
            isinstance(jwk, dict)
            and jwk.get("kty") == "OKP"
            and jwk.get("crv") == "Ed25519"
            and isinstance(jwk.get("kid"), str)
            and isinstance(jwk.get("x"), str)
        ):
            keys[jwk["kid"]] = Ed25519PublicKey.from_public_bytes(_b64url_decode(jwk["x"]))
    return keys


class NeonAuthVerifier:
    def __init__(self, *, base_url: str, jwks_url: str, now: Any = time.time) -> None:
        parts = urlsplit(base_url)
        self.issuer = f"{parts.scheme}://{parts.netloc}"
        self._jwks_url = jwks_url
        self._now = now
        self._keys: dict[str, Ed25519PublicKey] = {}
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    async def _key(self, kid: str) -> Ed25519PublicKey:
        stale = self._now() - self._fetched_at > JWKS_TTL_SECONDS
        if kid in self._keys and not stale:
            return self._keys[kid]
        async with self._lock:
            age = self._now() - self._fetched_at
            if (kid not in self._keys and age > MIN_REFRESH_SECONDS) or age > JWKS_TTL_SECONDS:
                try:
                    jwks = await asyncio.to_thread(_fetch_jwks, self._jwks_url)
                except (OSError, ValueError) as exc:
                    raise NeonAuthError("could not load the Neon Auth JWKS") from exc
                self._keys = _ed25519_keys(jwks)
                self._fetched_at = self._now()
        if kid not in self._keys:
            raise NeonAuthError("unknown signing key")
        return self._keys[kid]

    async def verify(self, token: str) -> NeonIdentity:
        try:
            header_b64, payload_b64, signature_b64 = token.split(".")
            header = json.loads(_b64url_decode(header_b64))
            payload = json.loads(_b64url_decode(payload_b64))
            signature = _b64url_decode(signature_b64)
        except ValueError as exc:
            raise NeonAuthError("malformed token") from exc
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise NeonAuthError("malformed token")
        if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
            raise NeonAuthError("unsupported token algorithm")
        key = await self._key(header["kid"])
        try:
            key.verify(signature, f"{header_b64}.{payload_b64}".encode("ascii"))
        except InvalidSignature as exc:
            raise NeonAuthError("bad signature") from exc

        now = self._now()
        exp, nbf = payload.get("exp"), payload.get("nbf")
        if not isinstance(exp, int) or exp + LEEWAY_SECONDS < now:
            raise NeonAuthError("token expired")
        if isinstance(nbf, int) and nbf - LEEWAY_SECONDS > now:
            raise NeonAuthError("token not yet valid")
        if payload.get("iss") != self.issuer:
            raise NeonAuthError("wrong issuer")
        sub = payload.get("sub")
        if not isinstance(sub, str) or not sub:
            raise NeonAuthError("token has no subject")
        email, name = payload.get("email"), payload.get("name")
        return NeonIdentity(
            user_id=sub,
            email=email if isinstance(email, str) else None,
            name=name if isinstance(name, str) else None,
            expires_at=exp,
        )
