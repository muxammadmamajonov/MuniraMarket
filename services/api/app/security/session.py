"""Server-side browser sessions (ADR 0007).

The browser holds an opaque random token in an HTTP-only cookie. Only ``sha256(token)`` is used
as the storage key, so a leaked database dump does not contain usable session tokens. Session
records carry their own CSRF token and the timestamps needed for idle expiry, absolute expiry
and periodic rotation; the policy lives in :class:`SessionManager`, storage behind the small
:class:`SessionStore` protocol (PostgreSQL ``auth_sessions`` in deployed environments, ADR 0013;
in-memory in unit tests).

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
from datetime import datetime
from typing import Any, Final, Literal, Protocol

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.models.security_state import AuthSession
from app.security.errors import StoreUnavailableError
from app.security.pg import SessionFactory, as_datetime, in_transaction

# Re-exported: routes and dependencies import the store error from here.
__all__ = ["StoreUnavailableError"]

logger = logging.getLogger("app.security.session")

SESSION_KEY_PREFIX: Final = "mm:sess"
TOKEN_BYTES: Final = 32
# secrets.token_urlsafe(32) -> 43 URL-safe base64 characters.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
_HASH_RE = re.compile(r"[0-9a-f]{64}")

AuthMethod = Literal["telegram_init_data", "telegram_oidc"]
# Which browser origin minted the session (gateway-owned entrance, ADR 0014). Back-office routes
# accept only ``admin`` sessions created through Telegram OIDC.
Entrance = Literal["storefront", "admin"]


class SessionGoneError(Exception):
    """The session was deleted (logout, block, login elsewhere) while a request was using it."""


class SwapResult(enum.IntEnum):
    """Outcome of :meth:`SessionStore.replace`."""

    GONE = 0  # the old key no longer exists: logged out / blocked concurrently
    SWAPPED = 1  # new record written, old key turned into a tombstone (or deleted)
    ALREADY_ROTATED = 2  # a parallel request rotated first: the old key is a tombstone


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
    entrance: Entrance = "storefront"

    def to_json(self) -> str:
        return json.dumps(
            {
                "user_id": str(self.user_id),
                "telegram_user_id": self.telegram_user_id,
                "csrf_token": self.csrf_token,
                "auth_method": self.auth_method,
                "created_at": self.created_at,
                "last_rotated_at": self.last_rotated_at,
                "entrance": self.entrance,
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
        elif auth_method == "telegram_oidc":
            method = "telegram_oidc"
        else:
            raise ValueError("unknown auth method")
        entrance_value = payload.get("entrance")
        if entrance_value == "storefront":
            entrance: Entrance = "storefront"
        elif entrance_value == "admin":
            entrance = "admin"
        else:
            raise ValueError("unknown entrance")
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
            entrance=entrance,
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
    """Process-local store for unit tests. Mirrors the TTL semantics with an injectable clock."""

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
        # Mirrors PostgresSessionStore.replace. No await between the check and the writes, so
        # this is atomic on the event loop.
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


class PostgresSessionStore:
    """``auth_sessions`` rows keyed by ``sha256(token)`` hex, expiring via ``expires_at``.

    Rows past ``expires_at`` are invisible to every operation (the cleanup job only reclaims
    their space), so expiry is exact without any background process.
    """

    def __init__(self, factory: SessionFactory, clock: Clock) -> None:
        self._factory = factory
        self._clock = clock

    def _now(self) -> datetime:
        return as_datetime(self._clock())

    def _expires(self, ttl_seconds: int) -> datetime:
        return as_datetime(self._clock() + ttl_seconds)

    async def get(self, token_hash: str) -> StoredRecord | None:
        now = self._now()

        async def work(db: AsyncSession) -> dict[str, Any] | None:
            row: dict[str, Any] | None = (
                await db.execute(
                    select(AuthSession.record).where(
                        AuthSession.token_hash == token_hash, AuthSession.expires_at > now
                    )
                )
            ).scalar_one_or_none()
            return row

        raw = await in_transaction(self._factory, work)
        if raw is None:
            return None
        record = _decode(json.dumps(raw))
        if record is None:
            await self.delete(token_hash)
        return record

    async def set(self, token_hash: str, data: SessionData, ttl_seconds: int) -> None:
        values = {
            "token_hash": token_hash,
            "record": json.loads(data.to_json()),
            "user_id": data.user_id,
            "expires_at": self._expires(ttl_seconds),
        }

        async def work(db: AsyncSession) -> None:
            statement = pg_insert(AuthSession).values(**values)
            await db.execute(
                statement.on_conflict_do_update(
                    index_elements=[AuthSession.token_hash],
                    set_={
                        "record": statement.excluded.record,
                        "user_id": statement.excluded.user_id,
                        "expires_at": statement.excluded.expires_at,
                    },
                )
            )

        await in_transaction(self._factory, work)

    async def expire(self, token_hash: str, ttl_seconds: int) -> bool:
        # Only an unexpired row is touched: an expired or deleted session is never revived.
        now, expires_at = self._now(), self._expires(ttl_seconds)

        async def work(db: AsyncSession) -> bool:
            result = await db.execute(
                update(AuthSession)
                .where(AuthSession.token_hash == token_hash, AuthSession.expires_at > now)
                .values(expires_at=expires_at)
                .returning(AuthSession.token_hash)
            )
            return result.first() is not None

        return await in_transaction(self._factory, work)

    async def delete(self, *token_hashes: str) -> None:
        if not token_hashes:
            return

        async def work(db: AsyncSession) -> None:
            await db.execute(
                delete(AuthSession).where(AuthSession.token_hash.in_(list(token_hashes)))
            )

        await in_transaction(self._factory, work)

    async def replace(
        self,
        old_hash: str,
        new_hash: str,
        data: SessionData,
        ttl_seconds: int,
        grace_seconds: int,
    ) -> SwapResult:
        """One transaction holding the old row's lock (``SELECT ... FOR UPDATE``).

        Under READ COMMITTED a waiter re-reads the row once the lock is released, so a parallel
        rotation that won sees the tombstone (``ALREADY_ROTATED``) and a concurrent logout or
        block that deleted the row sees nothing (``GONE``). Nothing is written in either case.
        """
        now = self._now()
        record = json.loads(data.to_json())
        new_expiry = self._expires(ttl_seconds)
        tombstone = json.loads(RotatedTombstone(new_hash).to_json())
        grace_expiry = self._expires(grace_seconds)

        async def work(db: AsyncSession) -> SwapResult:
            current = (
                await db.execute(
                    select(AuthSession.record)
                    .where(AuthSession.token_hash == old_hash, AuthSession.expires_at > now)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if current is None:
                return SwapResult.GONE
            if isinstance(current, dict) and "rotated_to" in current:
                return SwapResult.ALREADY_ROTATED
            await db.execute(
                pg_insert(AuthSession).values(
                    token_hash=new_hash,
                    record=record,
                    user_id=data.user_id,
                    expires_at=new_expiry,
                )
            )
            if grace_seconds > 0:
                await db.execute(
                    update(AuthSession)
                    .where(AuthSession.token_hash == old_hash)
                    .values(record=tombstone, user_id=None, expires_at=grace_expiry)
                )
            else:
                await db.execute(delete(AuthSession).where(AuthSession.token_hash == old_hash))
            return SwapResult.SWAPPED

        return await in_transaction(self._factory, work)

    async def revoke_user(self, user_id: uuid.UUID) -> None:
        """Delete every live session of ``user_id`` (their tombstones resolve to nothing)."""

        async def work(db: AsyncSession) -> None:
            await db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))

        await in_transaction(self._factory, work)


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
        entrance: Entrance = "storefront",
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
            entrance=entrance,
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
