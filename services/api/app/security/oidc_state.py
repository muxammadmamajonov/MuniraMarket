"""One-time Telegram OIDC login state (ADR 0014), stored in ``oidc_login_states``.

``take`` deletes the row and returns it in one statement (``DELETE ... RETURNING``), so a state
can be consumed at most once even when the same callback URL arrives twice in parallel.
"""

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.models.security_state import OidcLoginState
from app.security.pg import SessionFactory, as_datetime, in_transaction
from app.security.session import Entrance


@dataclass(frozen=True, slots=True)
class PendingLogin:
    binding_hash: str
    entrance: Entrance
    code_verifier: str
    nonce: str
    return_to: str
    created_at: int


class OidcStateStore(Protocol):
    async def put(self, state_hash: str, login: PendingLogin, ttl_seconds: int) -> None: ...

    async def take(self, state_hash: str) -> PendingLogin | None:
        """Remove and return the unexpired login for ``state_hash`` (``None`` otherwise)."""
        ...


def _entrance(value: str) -> Entrance:
    if value == "admin":
        return "admin"
    return "storefront"


class InMemoryOidcStateStore:
    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._rows: dict[str, tuple[PendingLogin, float]] = {}

    async def put(self, state_hash: str, login: PendingLogin, ttl_seconds: int) -> None:
        self._rows[state_hash] = (login, self._clock() + ttl_seconds)

    async def take(self, state_hash: str) -> PendingLogin | None:
        entry = self._rows.pop(state_hash, None)
        if entry is None or entry[1] <= self._clock():
            return None
        return entry[0]


class PostgresOidcStateStore:
    def __init__(self, factory: SessionFactory, clock: Clock) -> None:
        self._factory = factory
        self._clock = clock

    async def put(self, state_hash: str, login: PendingLogin, ttl_seconds: int) -> None:
        values = {
            "state_hash": state_hash,
            "binding_hash": login.binding_hash,
            "entrance": login.entrance,
            "code_verifier": login.code_verifier,
            "nonce": login.nonce,
            "return_to": login.return_to,
            "created_at_epoch": login.created_at,
            "expires_at": as_datetime(self._clock() + ttl_seconds),
        }

        async def work(db: AsyncSession) -> None:
            await db.execute(pg_insert(OidcLoginState).values(**values))

        await in_transaction(self._factory, work)

    async def take(self, state_hash: str) -> PendingLogin | None:
        now = as_datetime(self._clock())

        async def work(db: AsyncSession) -> PendingLogin | None:
            row = (
                await db.execute(
                    delete(OidcLoginState)
                    .where(OidcLoginState.state_hash == state_hash)
                    .returning(
                        OidcLoginState.binding_hash,
                        OidcLoginState.entrance,
                        OidcLoginState.code_verifier,
                        OidcLoginState.nonce,
                        OidcLoginState.return_to,
                        OidcLoginState.created_at_epoch,
                        OidcLoginState.expires_at,
                    )
                )
            ).first()
            if row is None or row.expires_at <= now:
                return None
            return PendingLogin(
                binding_hash=row.binding_hash,
                entrance=_entrance(row.entrance),
                code_verifier=row.code_verifier,
                nonce=row.nonce,
                return_to=row.return_to,
                created_at=row.created_at_epoch,
            )

        return await in_transaction(self._factory, work)
