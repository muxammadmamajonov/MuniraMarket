"""Audit log reads (admin only). Writes go through ``app.audit.record_audit`` exclusively."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.enums import UserRole


@dataclass(frozen=True, slots=True)
class AuditEntryRecord:
    id: uuid.UUID
    created_at: datetime
    actor_user_id: uuid.UUID | None
    actor_role: UserRole
    action: str
    entity_type: str
    entity_id: str
    details: dict[str, Any]


@dataclass(frozen=True, slots=True)
class AuditPageRecord:
    items: tuple[AuditEntryRecord, ...]
    total: int


@dataclass(frozen=True, slots=True)
class AuditFilter:
    entity_type: str | None = None
    entity_id: str | None = None
    action: str | None = None
    actor_user_id: uuid.UUID | None = None


class AuditRepository(Protocol):
    async def list_entries(
        self, filters: AuditFilter, *, page: int, page_size: int
    ) -> AuditPageRecord: ...


class SqlAlchemyAuditRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_entries(
        self, filters: AuditFilter, *, page: int, page_size: int
    ) -> AuditPageRecord:
        conditions: list[ColumnElement[bool]] = []
        if filters.entity_type is not None:
            conditions.append(AuditLog.entity_type == filters.entity_type)
        if filters.entity_id is not None:
            conditions.append(AuditLog.entity_id == filters.entity_id)
        if filters.action is not None:
            conditions.append(AuditLog.action == filters.action)
        if filters.actor_user_id is not None:
            conditions.append(AuditLog.actor_user_id == filters.actor_user_id)
        total = (
            await self._session.execute(
                select(func.count()).select_from(AuditLog).where(*conditions)
            )
        ).scalar_one()
        offset = (page - 1) * page_size
        if offset >= total:
            return AuditPageRecord(items=(), total=total)
        rows = await self._session.execute(
            select(AuditLog)
            .where(*conditions)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(page_size)
            .offset(offset)
        )
        return AuditPageRecord(
            items=tuple(
                AuditEntryRecord(
                    id=entry.id,
                    created_at=entry.created_at,
                    actor_user_id=entry.actor_user_id,
                    actor_role=entry.actor_role,
                    action=entry.action,
                    entity_type=entry.entity_type,
                    entity_id=entry.entity_id,
                    details=dict(entry.details),
                )
                for entry in rows.scalars()
            ),
            total=total,
        )
