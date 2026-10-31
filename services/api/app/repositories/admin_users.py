"""Admin user management: list/search users, change a role or block a user.

Kept apart from ``app.repositories.users`` (the sign-in path) so that interface stays small.
Phone numbers are never read here.

Last-admin rule: the shop must always keep at least one active (non-blocked) admin. A change that
removes an active admin first locks **every** active admin row ``FOR UPDATE`` in id order, then
the target, inside the same transaction, and only then counts. Two admins demoting each other at
the same moment therefore serialise on the first admin row: the second transaction re-reads the
rows after the first commits (PostgreSQL re-checks ``role = 'admin' AND NOT is_blocked`` on the
locked rows), sees one admin fewer and is refused with ``LastAdminError``.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditActor, AuditEntity, record_audit
from app.models.enums import Language, UserRole
from app.models.user import User
from app.repositories.catalog import escape_like

# A ``q`` of only digits (and this long) is matched exactly against the Telegram id.
MAX_TELEGRAM_ID_DIGITS = 19


class AdminUserError(Exception):
    """Base of the user-management rule violations."""


class UserNotFoundError(AdminUserError):
    pass


class LastAdminError(AdminUserError):
    pass


class CannotBlockSelfError(AdminUserError):
    pass


class ActorNotAdminError(AdminUserError):
    """The acting admin was demoted or blocked by a concurrent request."""


@dataclass(frozen=True, slots=True)
class AdminUserRecord:
    id: uuid.UUID
    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language: Language
    role: UserRole
    is_blocked: bool
    created_at: datetime


@dataclass(frozen=True, slots=True)
class AdminUserPageRecord:
    items: tuple[AdminUserRecord, ...]
    total: int


class AdminUserRepository(Protocol):
    async def list_users(
        self,
        *,
        query: str | None,
        role: UserRole | None,
        blocked: bool | None,
        page: int,
        page_size: int,
    ) -> AdminUserPageRecord: ...

    async def update_user(
        self,
        user_id: uuid.UUID,
        *,
        role: UserRole | None,
        is_blocked: bool | None,
        actor: AuditActor,
    ) -> AdminUserRecord:
        """Raises ``UserNotFoundError``, ``CannotBlockSelfError``, ``LastAdminError``."""
        ...


def _record(user: User) -> AdminUserRecord:
    return AdminUserRecord(
        id=user.id,
        telegram_user_id=user.telegram_user_id,
        first_name=user.first_name,
        last_name=user.last_name,
        username=user.username,
        language=user.language,
        role=user.role,
        is_blocked=user.is_blocked,
        created_at=user.created_at,
    )


def _is_active_admin(role: UserRole, is_blocked: bool) -> bool:
    return role is UserRole.ADMIN and not is_blocked


def search_condition(query: str) -> ColumnElement[bool]:
    pattern = f"%{escape_like(query)}%"
    by_name = or_(
        User.first_name.ilike(pattern, escape="\\"),
        User.last_name.ilike(pattern, escape="\\"),
        User.username.ilike(pattern, escape="\\"),
    )
    if query.isascii() and query.isdigit() and len(query) <= MAX_TELEGRAM_ID_DIGITS:
        telegram_id = int(query)
        if telegram_id < 2**63:
            return or_(by_name, User.telegram_user_id == telegram_id)
    return by_name


class SqlAlchemyAdminUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    async def list_users(
        self,
        *,
        query: str | None,
        role: UserRole | None,
        blocked: bool | None,
        page: int,
        page_size: int,
    ) -> AdminUserPageRecord:
        conditions: list[ColumnElement[bool]] = []
        if query:
            conditions.append(search_condition(query))
        if role is not None:
            conditions.append(User.role == role)
        if blocked is not None:
            conditions.append(User.is_blocked.is_(blocked))
        total = (
            await self._session.execute(select(func.count()).select_from(User).where(*conditions))
        ).scalar_one()
        offset = (page - 1) * page_size
        if offset >= total:
            return AdminUserPageRecord(items=(), total=total)
        users = await self._session.execute(
            select(User)
            .where(*conditions)
            .order_by(User.created_at.desc(), User.id.desc())
            .limit(page_size)
            .offset(offset)
        )
        return AdminUserPageRecord(
            items=tuple(_record(user) for user in users.scalars()), total=total
        )

    async def update_user(
        self,
        user_id: uuid.UUID,
        *,
        role: UserRole | None,
        is_blocked: bool | None,
        actor: AuditActor,
    ) -> AdminUserRecord:
        async with self._transaction():
            # Lock order: every active admin (id order), then the target.
            active_admins = set(
                (
                    await self._session.execute(
                        select(User.id)
                        .where(User.role == UserRole.ADMIN, User.is_blocked.is_(False))
                        .order_by(User.id)
                        .with_for_update()
                    )
                ).scalars()
            )
            user = (
                await self._session.execute(
                    select(User)
                    .where(User.id == user_id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).scalar_one_or_none()
            if user is None:
                raise UserNotFoundError()
            new_role = user.role if role is None else role
            new_blocked = user.is_blocked if is_blocked is None else is_blocked
            if new_blocked and not user.is_blocked and user.id == actor.user_id:
                raise CannotBlockSelfError()
            removes_admin = _is_active_admin(user.role, user.is_blocked) and not _is_active_admin(
                new_role, new_blocked
            )
            if removes_admin and not active_admins - {user.id}:
                raise LastAdminError()
            if actor.user_id not in active_admins:
                raise ActorNotAdminError()

            if new_role != user.role:
                record_audit(
                    self._session,
                    actor,
                    action="user.role_change",
                    entity_type=AuditEntity.USER,
                    entity_id=user.id,
                    changes={"role": (user.role, new_role)},
                )
                user.role = new_role
            if new_blocked != user.is_blocked:
                record_audit(
                    self._session,
                    actor,
                    action="user.block" if new_blocked else "user.unblock",
                    entity_type=AuditEntity.USER,
                    entity_id=user.id,
                    changes={"is_blocked": (user.is_blocked, new_blocked)},
                )
                user.is_blocked = new_blocked
            await self._session.flush()
            await self._session.refresh(user)
            return _record(user)
