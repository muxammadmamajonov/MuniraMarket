"""Service-to-service request signing (ADR 0003, ``MM-SVC-V1``).

Telegram Serverless -> Core API calls carry an HMAC-SHA256 signature over a canonical string that
includes the acting Telegram user, so the actor cannot be swapped in transit. Every failure is
reported to the caller as the same generic 401; the specific reason is only logged.
"""

import hashlib
import hmac
import logging
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Protocol

from fastapi import HTTPException, Request
from pydantic import SecretStr
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.clock import Clock

logger = logging.getLogger("app.security.service_auth")

VERSION: Final = "MM-SVC-V1"
HEADER_KEY_ID: Final = "X-MM-Key-Id"
HEADER_TIMESTAMP: Final = "X-MM-Timestamp"
HEADER_NONCE: Final = "X-MM-Nonce"
HEADER_ACTOR: Final = "X-MM-Actor"
HEADER_SIGNATURE: Final = "X-MM-Signature"

MAX_SKEW_SECONDS: Final = 300
# Must outlive the accepted timestamp window on both sides (2 x 300 s) plus a margin.
NONCE_TTL_SECONDS: Final = 660
MAX_BODY_BYTES: Final = 64 * 1024

_KEY_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")
_TIMESTAMP_RE = re.compile(r"[0-9]{1,12}")
_NONCE_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
_ACTOR_RE = re.compile(r"tg:([1-9][0-9]{0,17})")
_SIGNATURE_RE = re.compile(r"[0-9a-f]{64}")

_UNAUTHORIZED_DETAIL: Final = "Unauthorized"


class ServiceAuthError(Exception):
    """Internal-only; ``reason`` is logged but never returned to the client."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class ServiceContext:
    key_id: str
    actor_telegram_user_id: int | None


@dataclass(frozen=True, slots=True)
class PendingServiceRequest:
    """Headers that passed the pre-body checks; the signature is still unverified."""

    key_id: str
    secret: SecretStr
    timestamp: str
    nonce: str
    actor: str
    signature: str


def body_sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_string(
    *,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    path: str,
    actor: str,
    body: bytes,
) -> str:
    """Eight ``\\n``-joined lines, no trailing newline. ``path`` includes the query string."""
    return "\n".join(
        (
            VERSION,
            key_id,
            timestamp,
            nonce,
            method.upper(),
            path,
            actor,
            body_sha256_hex(body),
        )
    )


def sign(
    *,
    secret: str,
    key_id: str,
    timestamp: str,
    nonce: str,
    method: str,
    path: str,
    actor: str,
    body: bytes,
) -> str:
    """Lowercase-hex HMAC-SHA256 signature. Used by tests and reference tooling."""
    canonical = canonical_string(
        key_id=key_id,
        timestamp=timestamp,
        nonce=nonce,
        method=method,
        path=path,
        actor=actor,
        body=body,
    )
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


class NonceStore(Protocol):
    async def register(self, key_id: str, nonce: str, ttl_seconds: int) -> bool:
        """Record the nonce. Return ``False`` if it was already seen (replay)."""
        ...


class InMemoryNonceStore:
    """Process-local replay store for tests and single-process development."""

    def __init__(self, clock: Clock = time.time) -> None:
        self._clock = clock
        self._expiry: dict[str, float] = {}

    async def register(self, key_id: str, nonce: str, ttl_seconds: int) -> bool:
        now = self._clock()
        self._expiry = {k: exp for k, exp in self._expiry.items() if exp > now}
        key = f"{key_id}:{nonce}"
        if key in self._expiry:
            return False
        self._expiry[key] = now + ttl_seconds
        return True


class RedisNonceStore:
    """Replay store shared across instances: ``SET key 1 NX EX <ttl>``."""

    def __init__(self, client: Redis, prefix: str = "mm:svc-nonce") -> None:
        self._client = client
        self._prefix = prefix

    async def register(self, key_id: str, nonce: str, ttl_seconds: int) -> bool:
        stored = await self._client.set(
            f"{self._prefix}:{key_id}:{nonce}", "1", nx=True, ex=ttl_seconds
        )
        return bool(stored)


class ServiceAuthenticator:
    def __init__(
        self,
        *,
        keys: dict[str, SecretStr],
        nonce_store: NonceStore,
        clock: Clock = time.time,
    ) -> None:
        self._keys = keys
        self._nonce_store = nonce_store
        self._clock = clock

    async def authenticate(
        self, *, method: str, path: str, headers: Mapping[str, str], body: bytes
    ) -> ServiceContext:
        pending = self.precheck(headers)
        return await self.verify(pending, method=method, path=path, body=body)

    def precheck(self, headers: Mapping[str, str]) -> "PendingServiceRequest":
        """Cheap checks that need no request body: header shapes, known key, timestamp skew."""
        key_id = headers.get(HEADER_KEY_ID, "")
        timestamp = headers.get(HEADER_TIMESTAMP, "")
        nonce = headers.get(HEADER_NONCE, "")
        actor = headers.get(HEADER_ACTOR, "")
        signature = headers.get(HEADER_SIGNATURE, "")

        # 1. Presence and shape of every header.
        if not (
            _KEY_ID_RE.fullmatch(key_id)
            and _TIMESTAMP_RE.fullmatch(timestamp)
            and _NONCE_RE.fullmatch(nonce)
            and _SIGNATURE_RE.fullmatch(signature)
        ):
            raise ServiceAuthError("malformed_headers")
        actor_match = _ACTOR_RE.fullmatch(actor) if actor else None
        if actor and actor_match is None:
            raise ServiceAuthError("malformed_actor")

        # 2. Known key.
        secret = self._keys.get(key_id)
        if secret is None:
            raise ServiceAuthError("unknown_key")

        # 3. Timestamp skew.
        if abs(self._clock() - int(timestamp)) > MAX_SKEW_SECONDS:
            raise ServiceAuthError("timestamp_skew")

        return PendingServiceRequest(
            key_id=key_id,
            secret=secret,
            timestamp=timestamp,
            nonce=nonce,
            actor=actor,
            signature=signature,
        )

    async def verify(
        self, pending: "PendingServiceRequest", *, method: str, path: str, body: bytes
    ) -> ServiceContext:
        """Signature and replay checks; needs the full body."""
        key_id, nonce, actor, signature = (
            pending.key_id,
            pending.nonce,
            pending.actor,
            pending.signature,
        )
        # 4. Signature, compared in constant time.
        expected = sign(
            secret=pending.secret.get_secret_value(),
            key_id=key_id,
            timestamp=pending.timestamp,
            nonce=nonce,
            method=method,
            path=path,
            actor=actor,
            body=body,
        )
        if not hmac.compare_digest(expected.encode("ascii"), signature.encode("ascii")):
            raise ServiceAuthError("bad_signature")

        # 5. Replay protection - only reached with a valid signature.
        if not await self._nonce_store.register(key_id, nonce, NONCE_TTL_SECONDS):
            raise ServiceAuthError("replayed_nonce")

        return ServiceContext(
            key_id=key_id,
            actor_telegram_user_id=int(actor[3:]) if actor else None,
        )


def request_path_with_query(request: Request) -> str:
    """Path plus query string exactly as sent on the wire (before percent-decoding)."""
    raw_path = request.scope.get("raw_path")
    path_bytes: bytes = raw_path if isinstance(raw_path, bytes) else request.url.path.encode()
    query = request.scope.get("query_string", b"")
    full = path_bytes + (b"?" + query if query else b"")
    return full.decode("utf-8")


async def _read_body_capped(request: Request, limit: int) -> bytes:
    """Read the body with a hard byte cap, then cache it so the route can parse it again."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isascii() and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Request body too large")
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > limit:
            raise HTTPException(status_code=413, detail="Request body too large")
        chunks.append(chunk)
    body = b"".join(chunks)
    # Starlette's Request.body()/stream() replay from `_body` once it is set.
    request._body = body
    return body


async def require_service_request(request: Request) -> ServiceContext:
    """FastAPI dependency: authenticate a signed internal request or raise a generic 401.

    Cheap header/key/timestamp checks run before the body is read, and the body is capped.
    """
    authenticator: ServiceAuthenticator = request.app.state.service_authenticator
    try:
        pending = authenticator.precheck(request.headers)
        body = await _read_body_capped(request, MAX_BODY_BYTES)
        return await authenticator.verify(
            pending,
            method=request.method,
            path=request_path_with_query(request),
            body=body,
        )
    except ServiceAuthError as exc:
        logger.warning("Service request rejected: %s", exc.reason)
    except UnicodeDecodeError:
        logger.warning("Service request rejected: undecodable path")
    except RedisError:
        # Only reachable after a valid signature, so this reveals nothing to an attacker.
        logger.exception("Replay store unavailable; failing closed")
        raise HTTPException(status_code=503, detail="Service unavailable") from None
    raise HTTPException(status_code=401, detail=_UNAUTHORIZED_DETAIL)
