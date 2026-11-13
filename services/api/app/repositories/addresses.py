"""The customer's saved delivery addresses, behind a small interface (faked in route tests).

Ownership is part of every statement (``WHERE id = :id AND user_id = :user``), so another user's
address is indistinguishable from a missing one. Every write is one transaction that first locks
the owner's ``users`` row (``FOR UPDATE``): concurrent writes for one user are serialised, so the
10-address limit and the single default cannot be raced. Turning another address's default flag
off (or on, when promoting) is bookkeeping, not an edit: its ``updated_at`` stays as it was.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.profile import MAX_SAVED_ADDRESSES
from app.models.address import UserAddress
from app.models.user import User


class AddressLimitReachedError(Exception):
    """The user already has ``MAX_SAVED_ADDRESSES`` saved addresses."""


@dataclass(frozen=True, slots=True)
class AddressInput:
    """A validated ``SavedAddressRequest`` without ``is_default``."""

    label: str | None
    lat: float
    lon: float
    street: str
    house: str
    apartment: str | None
    entrance: str | None
    floor: str | None
    landmark: str | None


@dataclass(frozen=True, slots=True)
class SavedAddressRecord:
    id: uuid.UUID
    label: str | None
    lat: float
    lon: float
    street: str
    house: str
    apartment: str | None
    entrance: str | None
    floor: str | None
    landmark: str | None
    is_default: bool
    created_at: datetime
    updated_at: datetime


class AddressRepository(Protocol):
    async def list_for_user(self, user_id: uuid.UUID) -> list[SavedAddressRecord]: ...

    async def create(
        self, user_id: uuid.UUID, data: AddressInput, *, is_default: bool | None
    ) -> SavedAddressRecord: ...

    async def replace(
        self,
        user_id: uuid.UUID,
        address_id: uuid.UUID,
        data: AddressInput,
        *,
        is_default: bool | None,
    ) -> SavedAddressRecord | None: ...

    async def delete(self, user_id: uuid.UUID, address_id: uuid.UUID) -> bool: ...


_COLUMNS = (
    UserAddress.id,
    UserAddress.label,
    UserAddress.lat,
    UserAddress.lon,
    UserAddress.street,
    UserAddress.house,
    UserAddress.apartment,
    UserAddress.entrance,
    UserAddress.floor,
    UserAddress.landmark,
    UserAddress.is_default,
    UserAddress.created_at,
    UserAddress.updated_at,
)


def _record(row: Any) -> SavedAddressRecord:
    return SavedAddressRecord(
        id=row.id,
        label=row.label,
        lat=row.lat,
        lon=row.lon,
        street=row.street,
        house=row.house,
        apartment=row.apartment,
        entrance=row.entrance,
        floor=row.floor,
        landmark=row.landmark,
        is_default=row.is_default,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _values(data: AddressInput) -> dict[str, Any]:
    return {
        "label": data.label,
        "lat": data.lat,
        "lon": data.lon,
        "street": data.street,
        "house": data.house,
        "apartment": data.apartment,
        "entrance": data.entrance,
        "floor": data.floor,
        "landmark": data.landmark,
    }


class SqlAlchemyAddressRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_for_user(self, user_id: uuid.UUID) -> list[SavedAddressRecord]:
        """The default first, then the most recently updated."""
        rows = (
            await self._session.execute(
                select(*_COLUMNS)
                .where(UserAddress.user_id == user_id)
                .order_by(
                    UserAddress.is_default.desc(),
                    UserAddress.updated_at.desc(),
                    UserAddress.id.desc(),
                )
            )
        ).all()
        return [_record(row) for row in rows]

    async def create(
        self, user_id: uuid.UUID, data: AddressInput, *, is_default: bool | None
    ) -> SavedAddressRecord:
        """Save a new address. The user's first address is the default whatever was asked."""
        async with self._transaction():
            await self._lock_owner(user_id)
            count = (
                await self._session.execute(
                    select(func.count())
                    .select_from(UserAddress)
                    .where(UserAddress.user_id == user_id)
                )
            ).scalar_one()
            if count >= MAX_SAVED_ADDRESSES:
                raise AddressLimitReachedError
            make_default = count == 0 or is_default is True
            if make_default:
                await self._unset_default(user_id)
            row = (
                await self._session.execute(
                    insert(UserAddress)
                    .values(user_id=user_id, is_default=make_default, **_values(data))
                    .returning(*_COLUMNS)
                )
            ).one()
            return _record(row)

    async def replace(
        self,
        user_id: uuid.UUID,
        address_id: uuid.UUID,
        data: AddressInput,
        *,
        is_default: bool | None,
    ) -> SavedAddressRecord | None:
        """Overwrite every field; ``is_default`` ``True`` / ``False`` / ``None`` (keep)."""
        async with self._transaction():
            await self._lock_owner(user_id)
            owned = (
                await self._session.execute(
                    select(UserAddress.id).where(
                        UserAddress.id == address_id, UserAddress.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            if owned is None:
                return None
            values = _values(data)
            if is_default is not None:
                if is_default:
                    await self._unset_default(user_id, keep=address_id)
                values["is_default"] = is_default
            row = (
                await self._session.execute(
                    update(UserAddress)
                    .where(UserAddress.id == address_id, UserAddress.user_id == user_id)
                    .values(updated_at=func.now(), **values)
                    .returning(*_COLUMNS)
                )
            ).one()
            return _record(row)

    async def delete(self, user_id: uuid.UUID, address_id: uuid.UUID) -> bool:
        """Remove the address; deleting the default promotes the most recently updated one."""
        async with self._transaction():
            await self._lock_owner(user_id)
            was_default = (
                await self._session.execute(
                    delete(UserAddress)
                    .where(UserAddress.id == address_id, UserAddress.user_id == user_id)
                    .returning(UserAddress.is_default)
                )
            ).scalar_one_or_none()
            if was_default is None:
                return False
            if was_default:
                newest = (
                    select(UserAddress.id)
                    .where(UserAddress.user_id == user_id)
                    .order_by(
                        UserAddress.updated_at.desc(),
                        UserAddress.created_at.desc(),
                        UserAddress.id.desc(),
                    )
                    .limit(1)
                    .scalar_subquery()
                )
                await self._session.execute(
                    update(UserAddress)
                    .where(UserAddress.id == newest)
                    .values(is_default=True, updated_at=UserAddress.updated_at)
                )
            return True

    # --- internals -------------------------------------------------------------------------------

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    async def _lock_owner(self, user_id: uuid.UUID) -> None:
        await self._session.execute(select(User.id).where(User.id == user_id).with_for_update())

    async def _unset_default(self, user_id: uuid.UUID, *, keep: uuid.UUID | None = None) -> None:
        conditions = [UserAddress.user_id == user_id, UserAddress.is_default.is_(True)]
        if keep is not None:
            conditions.append(UserAddress.id != keep)
        await self._session.execute(
            update(UserAddress)
            .where(*conditions)
            .values(is_default=False, updated_at=UserAddress.updated_at)
        )
