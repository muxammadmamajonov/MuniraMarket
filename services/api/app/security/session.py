"""Server-side browser sessions (ADR 0007).

The browser holds an opaque random token in an HTTP-only cookie. Only ``sha256(token)`` is used
as the storage key, so a leaked Redis dump does not contain usable session tokens. Session
records carry their own CSRF token and the timestamps needed for idle expiry, absolute expiry
and periodic rotation; the policy lives in :class:`SessionManager`, storage behind the small
:class:`SessionStore` protocol (Redis in deployed environments, in-memory in tests).
"""

import hashlib
import json
import logging
import re
import secrets
import uuid
from dataclasses import dataclass, replace
from typing import Final, Literal, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.clock import Clock

logger = logging.getLogger("app.security.session")

SESSION_KEY_PREFIX: Final = "mm:sess"
TOKEN_BYTES: Final = 32
# secrets.token_urlsafe(32) -> 43 URL-safe base64 characters.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")

AuthMethod = Literal["telegram_init_data", "telegram_login_widget"]


class StoreUnavailableError(Exception):
    """The backing store (Redis) failed. Callers fail closed with 503."""


class SessionGoneError(Exception):
    """The session was deleted (logout, block, login elsewhere) while a request was using it."""


# Rotation must never resurrect a session that a concurrent logout/block just deleted, so the
# swap is conditional on the old key still existing, in one atomic script.
# KEYS[1] = old key, KEYS[2] = new key, ARGV[1] = record JSON, ARGV[2] = TTL seconds.
REPLACE_IF_EXISTS_LUA: Final = """\
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[1])
return 1
"""


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def is_well_formed_token(token: str) -> bool:
    return _TOKEN_RE.fullmatch(token) is not None


@dataclass(frozen=True, slots=True)
class SessionData:
    user_id: uuid.UUID
    telegram_user_id: int
    csrf_token: str
    auth_method: AuthMethod
    created_at: int
    last_rotated_at: int

    def to_json(self) -> str:
        return json.dumps(
            {
                "user_id": str(self.user_id),
                "telegram_user_id": self.telegram_user_id,
                "csrf_token": self.csrf_token,
                "auth_method": self.auth_method,
                "created_at": self.created_at,
                "last_rotated_at": self.last_rotated_at,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_json(cls, raw: str | bytes) -> "SessionData":
        """Parse a stored record; raises ``ValueError`` on anything unexpected."""
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("session record is not an object")  # noqa: TRY004
        auth_method = payload.get("auth_method")
        if auth_method == "telegram_init_data":
            method: AuthMethod = "telegram_init_data"
        elif auth_method == "telegram_login_widget":
            method = "telegram_login_widget"
        else:
            raise ValueError("unknown auth method")
        ints = [payload.get(k) for k in ("telegram_user_id", "created_at", "last_rotated_at")]
        if any(isinstance(v, bool) or not isinstance(v, int) for v in ints):
            raise ValueError("session record has invalid integers")
        csrf_token = payload.get("csrf_token")
        if not isinstance(csrf_token, str) or not csrf_token:
            raise ValueError("session record has no csrf token")
        return cls(
            user_id=uuid.UUID(str(payload.get("user_id"))),
            telegram_user_id=payload["telegram_user_id"],
            csrf_token=csrf_token,
            auth_method=method,
            created_at=payload["created_at"],
            last_rotated_at=payload["last_rotated_at"],
        )


class SessionStore(Protocol):
    """Session records keyed by ``sha256(token)`` hex. Raise :class:`StoreUnavailableError`."""

    async def get(self, token_hash: str) -> SessionData | None: ...

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None: ...

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        """Reset the TTL of an existing record; never creates one. ``False`` if it is gone."""
        ...

    async def delete(self, token_hash: str) -> None: ...

    async def replace(
        self, old_hash: str, new_hash: str, data: SessionData, ttl_seconds: int
    ) -> bool:
        """Atomically store ``data`` under ``new_hash`` and delete ``old_hash``, but only if
        ``old_hash`` still exists. Returns ``False`` (and writes nothing) otherwise."""
        ...


def _decode(raw: str | bytes | None) -> SessionData | None:
    if raw is None:
        return None
    try:
        return SessionData.from_json(raw)
    except (ValueError, TypeError):
        logger.warning("Discarding malformed session record")
        return None


class InMemorySessionStore:
    """Process-local store for tests. Mirrors Redis TTL semantics with an injectable clock."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._records: dict[str, tuple[str, float]] = {}

    def _live(self, token_hash: str) -> str | None:
        entry = self._records.get(token_hash)
        if entry is None:
            return None
        raw, expires_at = entry
        if expires_at <= self._clock():
            del self._records[token_hash]
            return None
        return raw

    def __len__(self) -> int:
        return sum(1 for key in list(self._records) if self._live(key) is not None)

    async def get(self, token_hash: str) -> SessionData | None:
        raw = self._live(token_hash)
        data = _decode(raw)
        if raw is not None and data is None:
            del self._records[token_hash]
        return data

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None:
        self._records[token_hash] = (data.to_json(), self._clock() + ttl_seconds)

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        raw = self._live(token_hash)
        if raw is None:
            return False
        self._records[token_hash] = (raw, self._clock() + ttl_seconds)
        return True

    async def delete(self, token_hash: str) -> None:
        self._records.pop(token_hash, None)

    async def replace(
        self, old_hash: str, new_hash: str, data: SessionData, ttl_seconds: int
    ) -> bool:
        # No await between the check and the writes, so this is atomic on the event loop.
        if self._live(old_hash) is None:
            return False
        self._records[new_hash] = (data.to_json(), self._clock() + ttl_seconds)
        del self._records[old_hash]
        return True


class RedisSessionStore:
    """``mm:sess:<sha256-hex(token)>`` -> JSON record, expiring with ``EX``/``EXPIRE``."""

    def __init__(self, client: Redis, prefix: str = SESSION_KEY_PREFIX) -> None:
        self._client = client
        self._prefix = prefix

    def _key(self, token_hash: str) -> str:
        return f"{self._prefix}:{token_hash}"

    async def get(self, token_hash: str) -> SessionData | None:
        try:
            raw = await self._client.get(self._key(token_hash))
        except RedisError:
            raise StoreUnavailableError from None
        data = _decode(raw)
        if raw is not None and data is None:
            await self.delete(token_hash)
        return data

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None:
        try:
            await self._client.set(self._key(token_hash), data.to_json(), ex=ttl_seconds)
        except RedisError:
            raise StoreUnavailableError from None

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        # EXPIRE on a missing key is a no-op returning 0: it never recreates a deleted session.
        try:
            return bool(await self._client.expire(self._key(token_hash), ttl_seconds))
        except RedisError:
            raise StoreUnavailableError from None

    async def delete(self, token_hash: str) -> None:
        try:
            await self._client.delete(self._key(token_hash))
        except RedisError:
            raise StoreUnavailableError from None

    async def replace(
        self, old_hash: str, new_hash: str, data: SessionData, ttl_seconds: int
    ) -> bool:
        try:
            swapped = await self._client.eval(
                REPLACE_IF_EXISTS_LUA,
                2,
                self._key(old_hash),
                self._key(new_hash),
                data.to_json(),
                str(ttl_seconds),
            )
        except RedisError:
            raise StoreUnavailableError from None
        return bool(int(swapped))


@dataclass(frozen=True, slots=True)
class IssuedSession:
    """A freshly minted (login) or rotated session. ``token`` goes into the cookie only."""

    token: str
    data: SessionData
    max_age_seconds: int


@dataclass(frozen=True, slots=True)
class LoadedSession:
    token: str
    data: SessionData
    absolute_remaining_seconds: int


class SessionManager:
    """Session policy: sliding idle TTL, absolute lifetime, rotation and revocation."""

    def __init__(
        self,
        *,
        store: SessionStore,
        clock: Clock,
        idle_ttl_seconds: int,
        absolute_ttl_seconds: int,
        rotate_after_seconds: int,
    ) -> None:
        self._store = store
        self._clock = clock
        self._idle_ttl = idle_ttl_seconds
        self._absolute_ttl = absolute_ttl_seconds
        self._rotate_after = rotate_after_seconds

    def _now(self) -> int:
        return int(self._clock())

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        telegram_user_id: int,
        auth_method: AuthMethod,
        previous_token: str | None = None,
    ) -> IssuedSession:
        """Mint a new session. The session presented with the login request is always
        destroyed first (anti-fixation), whoever it belonged to."""
        if previous_token is not None:
            await self.revoke(previous_token)
        now = self._now()
        data = SessionData(
            user_id=user_id,
            telegram_user_id=telegram_user_id,
            csrf_token=secrets.token_urlsafe(TOKEN_BYTES),
            auth_method=auth_method,
            created_at=now,
            last_rotated_at=now,
        )
        token = new_token()
        await self._store.set(hash_token(token), data, min(self._idle_ttl, self._absolute_ttl))
        return IssuedSession(token=token, data=data, max_age_seconds=self._absolute_ttl)

    async def load(self, token: str) -> LoadedSession | None:
        """Look the session up and slide its idle expiry. ``None`` if unknown or expired."""
        if not is_well_formed_token(token):
            return None
        token_hash = hash_token(token)
        data = await self._store.get(token_hash)
        if data is None:
            return None
        remaining = data.created_at + self._absolute_ttl - self._now()
        if remaining <= 0:
            await self._store.delete(token_hash)
            return None
        if not await self._store.expire(token_hash, min(self._idle_ttl, remaining)):
            return None  # deleted concurrently
        return LoadedSession(token=token, data=data, absolute_remaining_seconds=remaining)

    async def peek(self, token: str) -> SessionData | None:
        """Look the session up without sliding its expiry (used by logout)."""
        if not is_well_formed_token(token):
            return None
        return await self._store.get(hash_token(token))

    async def rotate_if_due(self, loaded: LoadedSession) -> IssuedSession | None:
        """Swap the token once ``rotate_after`` has passed; the CSRF token is kept.

        Raises :class:`SessionGoneError` if the session was deleted since it was loaded.
        """
        now = self._now()
        if now - loaded.data.last_rotated_at < self._rotate_after:
            return None
        data = replace(loaded.data, last_rotated_at=now)
        token = new_token()
        remaining = loaded.absolute_remaining_seconds
        swapped = await self._store.replace(
            hash_token(loaded.token), hash_token(token), data, min(self._idle_ttl, remaining)
        )
        if not swapped:
            raise SessionGoneError
        return IssuedSession(token=token, data=data, max_age_seconds=remaining)

    async def revoke(self, token: str) -> None:
        if is_well_formed_token(token):
            await self._store.delete(hash_token(token))
