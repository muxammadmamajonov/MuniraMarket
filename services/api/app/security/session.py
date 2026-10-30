"""Server-side browser sessions (ADR 0007).

The browser holds an opaque random token in an HTTP-only cookie. Only ``sha256(token)`` is used
as the storage key, so a leaked Redis dump does not contain usable session tokens. Session
records carry their own CSRF token and the timestamps needed for idle expiry, absolute expiry
and periodic rotation; the policy lives in :class:`SessionManager`, storage behind the small
:class:`SessionStore` protocol (Redis in deployed environments, in-memory in tests).

Rotation leaves a short-lived tombstone ``{"rotated_to": "<new hash>"}`` under the old key, so
requests the browser sent in parallel with the old cookie still resolve to the session during
``SESSION_ROTATION_GRACE_SECONDS`` instead of failing (and racing the new cookie).
"""

import enum
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
_HASH_RE = re.compile(r"[0-9a-f]{64}")

AuthMethod = Literal["telegram_init_data", "telegram_login_widget"]


class StoreUnavailableError(Exception):
    """The backing store (Redis) failed. Callers fail closed with 503."""


class SessionGoneError(Exception):
    """The session was deleted (logout, block, login elsewhere) while a request was using it."""


class SwapResult(enum.IntEnum):
    """Outcome of :meth:`SessionStore.replace` (the value is what the Lua script returns)."""

    GONE = 0  # the old key no longer exists: logged out / blocked concurrently
    SWAPPED = 1  # new record written, old key turned into a tombstone (or deleted)
    ALREADY_ROTATED = 2  # a parallel request rotated first: the old key is a tombstone


# Rotation must never resurrect a session that a concurrent logout/block just deleted, so the
# swap is conditional on the old key still existing, in one atomic script. The old key is not
# deleted but rewritten into a tombstone pointing at the new key for the grace period (a grace of
# 0 deletes it). An old key that already is a tombstone is left alone: a parallel request
# rotated first, and rotating again would fork the session into two live records.
# KEYS[1] = old key, KEYS[2] = new key, ARGV[1] = record JSON, ARGV[2] = TTL seconds,
# ARGV[3] = tombstone JSON, ARGV[4] = grace seconds.
ROTATE_SESSION_LUA: Final = """\
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ok, record = pcall(cjson.decode, current)
if ok and type(record) == 'table' and record['rotated_to'] ~= nil then
  return 2
end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
if tonumber(ARGV[4]) > 0 then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
else
  redis.call('DEL', KEYS[1])
end
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


@dataclass(frozen=True, slots=True)
class RotatedTombstone:
    """What a rotated-away token's key holds during the grace period."""

    rotated_to: str  # sha256 hex of the successor token

    def to_json(self) -> str:
        return json.dumps({"rotated_to": self.rotated_to}, separators=(",", ":"))


StoredRecord = SessionData | RotatedTombstone


class SessionStore(Protocol):
    """Session records keyed by ``sha256(token)`` hex. Raise :class:`StoreUnavailableError`."""

    async def get(self, token_hash: str) -> StoredRecord | None: ...

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None: ...

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        """Reset the TTL of an existing record; never creates one. ``False`` if it is gone."""
        ...

    async def delete(self, *token_hashes: str) -> None: ...

    async def replace(
        self,
        old_hash: str,
        new_hash: str,
        data: SessionData,
        ttl_seconds: int,
        grace_seconds: int,
    ) -> SwapResult:
        """Atomically store ``data`` under ``new_hash`` and turn ``old_hash`` into a tombstone
        pointing at it for ``grace_seconds`` (deleted when 0), but only if ``old_hash`` still
        holds a live record. Writes nothing for ``GONE`` and ``ALREADY_ROTATED``."""
        ...


def _decode(raw: str | bytes | None) -> StoredRecord | None:
    if raw is None:
        return None
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict) and set(payload) == {"rotated_to"}:
            rotated_to = payload["rotated_to"]
            if not isinstance(rotated_to, str) or not _HASH_RE.fullmatch(rotated_to):
                raise ValueError("malformed tombstone")  # noqa: TRY301
            return RotatedTombstone(rotated_to)
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

    async def get(self, token_hash: str) -> StoredRecord | None:
        raw = self._live(token_hash)
        record = _decode(raw)
        if raw is not None and record is None:
            del self._records[token_hash]
        return record

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None:
        self._records[token_hash] = (data.to_json(), self._clock() + ttl_seconds)

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        raw = self._live(token_hash)
        if raw is None:
            return False
        self._records[token_hash] = (raw, self._clock() + ttl_seconds)
        return True

    async def delete(self, *token_hashes: str) -> None:
        for token_hash in token_hashes:
            self._records.pop(token_hash, None)

    async def replace(
        self,
        old_hash: str,
        new_hash: str,
        data: SessionData,
        ttl_seconds: int,
        grace_seconds: int,
    ) -> SwapResult:
        # Mirrors ROTATE_SESSION_LUA. No await between the check and the writes, so this is
        # atomic on the event loop.
        raw = self._live(old_hash)
        if raw is None:
            return SwapResult.GONE
        if isinstance(_decode(raw), RotatedTombstone):
            return SwapResult.ALREADY_ROTATED
        now = self._clock()
        self._records[new_hash] = (data.to_json(), now + ttl_seconds)
        if grace_seconds > 0:
            self._records[old_hash] = (RotatedTombstone(new_hash).to_json(), now + grace_seconds)
        else:
            del self._records[old_hash]
        return SwapResult.SWAPPED


class RedisSessionStore:
    """``mm:sess:<sha256-hex(token)>`` -> JSON record, expiring with ``EX``/``EXPIRE``."""

    def __init__(self, client: Redis, prefix: str = SESSION_KEY_PREFIX) -> None:
        self._client = client
        self._prefix = prefix

    def _key(self, token_hash: str) -> str:
        return f"{self._prefix}:{token_hash}"

    async def get(self, token_hash: str) -> StoredRecord | None:
        try:
            raw = await self._client.get(self._key(token_hash))
        except RedisError:
            raise StoreUnavailableError from None
        record = _decode(raw)
        if raw is not None and record is None:
            await self.delete(token_hash)
        return record

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

    async def delete(self, *token_hashes: str) -> None:
        try:
            await self._client.delete(*(self._key(token_hash) for token_hash in token_hashes))
        except RedisError:
            raise StoreUnavailableError from None

    async def replace(
        self,
        old_hash: str,
        new_hash: str,
        data: SessionData,
        ttl_seconds: int,
        grace_seconds: int,
    ) -> SwapResult:
        try:
            result = await self._client.eval(
                ROTATE_SESSION_LUA,
                2,
                self._key(old_hash),
                self._key(new_hash),
                data.to_json(),
                str(ttl_seconds),
                RotatedTombstone(new_hash).to_json(),
                str(grace_seconds),
            )
        except RedisError:
            raise StoreUnavailableError from None
        return SwapResult(int(result))


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
    # True when ``token`` was already rotated away and was resolved through its tombstone: the
    # request is served, but the session is not rotated again and no cookie is sent.
    via_tombstone: bool = False


@dataclass(frozen=True, slots=True)
class _Resolved:
    data: SessionData
    live_hash: str  # where the record lives
    hashes: tuple[str, ...]  # every key the presented token reached (tombstone, then live)


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
        rotation_grace_seconds: int = 0,
    ) -> None:
        self._store = store
        self._clock = clock
        self._idle_ttl = idle_ttl_seconds
        self._absolute_ttl = absolute_ttl_seconds
        self._rotate_after = rotate_after_seconds
        self._grace = rotation_grace_seconds

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

    async def _resolve(self, token: str) -> _Resolved | None:
        """Find the live record for ``token``, following at most one tombstone. Never a chain:
        a tombstone pointing at another tombstone resolves to nothing."""
        if not is_well_formed_token(token):
            return None
        token_hash = hash_token(token)
        record = await self._store.get(token_hash)
        if isinstance(record, RotatedTombstone):
            successor = await self._store.get(record.rotated_to)
            if not isinstance(successor, SessionData):
                return None
            return _Resolved(successor, record.rotated_to, (token_hash, record.rotated_to))
        if record is None:
            return None
        return _Resolved(record, token_hash, (token_hash,))

    async def load(self, token: str) -> LoadedSession | None:
        """Look the session up and slide its idle expiry. ``None`` if unknown or expired."""
        resolved = await self._resolve(token)
        if resolved is None:
            return None
        remaining = resolved.data.created_at + self._absolute_ttl - self._now()
        if remaining <= 0:
            await self._store.delete(*resolved.hashes)
            return None
        if not await self._store.expire(resolved.live_hash, min(self._idle_ttl, remaining)):
            return None  # deleted concurrently
        return LoadedSession(
            token=token,
            data=resolved.data,
            absolute_remaining_seconds=remaining,
            via_tombstone=len(resolved.hashes) > 1,
        )

    async def peek(self, token: str) -> SessionData | None:
        """Look the session up without sliding its expiry (used by logout)."""
        resolved = await self._resolve(token)
        return resolved.data if resolved is not None else None

    async def rotate_if_due(self, loaded: LoadedSession) -> IssuedSession | None:
        """Swap the token once ``rotate_after`` has passed; the CSRF token is kept.

        Returns ``None`` when no rotation is due, when ``loaded`` came through a tombstone, and
        when a parallel request rotated the same token first (that request's response carries
        the cookie). Raises :class:`SessionGoneError` if the session was deleted since it was
        loaded.
        """
        if loaded.via_tombstone:
            return None
        now = self._now()
        if now - loaded.data.last_rotated_at < self._rotate_after:
            return None
        data = replace(loaded.data, last_rotated_at=now)
        token = new_token()
        remaining = loaded.absolute_remaining_seconds
        result = await self._store.replace(
            hash_token(loaded.token),
            hash_token(token),
            data,
            min(self._idle_ttl, remaining),
            min(self._grace, remaining),
        )
        if result is SwapResult.GONE:
            raise SessionGoneError
        if result is SwapResult.ALREADY_ROTATED:
            return None
        return IssuedSession(token=token, data=data, max_age_seconds=remaining)

    async def revoke(self, token: str) -> None:
        """Delete the session ``token`` belongs to. A rotated-away token still in its grace
        period takes the tombstone and the live successor down together."""
        if not is_well_formed_token(token):
            return
        token_hash = hash_token(token)
        record = await self._store.get(token_hash)
        if isinstance(record, RotatedTombstone):
            await self._store.delete(token_hash, record.rotated_to)
        else:
            await self._store.delete(token_hash)
