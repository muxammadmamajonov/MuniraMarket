"""Audit log response models (admin only)."""

import math
import uuid
from datetime import datetime
from typing import Any, Self

from pydantic import BaseModel, Field

from app.models.enums import UserRole
from app.repositories.audit import AuditEntryRecord, AuditPageRecord


class AuditEntry(BaseModel):
    id: uuid.UUID
    created_at: datetime
    # null for changes made by the system rather than a signed-in user.
    actor_user_id: uuid.UUID | None
    actor_role: UserRole
    action: str = Field(examples=["product.update"])
    entity_type: str = Field(examples=["product"])
    entity_id: str
    # ``{"changes": {field: {"from": .., "to": ..}}, ...}``: allow-listed, non-personal scalars.
    details: dict[str, Any]

    @classmethod
    def from_record(cls, record: AuditEntryRecord) -> Self:
        return cls(
            id=record.id,
            created_at=record.created_at,
            actor_user_id=record.actor_user_id,
            actor_role=record.actor_role,
            action=record.action,
            entity_type=record.entity_type,
            entity_id=record.entity_id,
            details=record.details,
        )


class AuditPage(BaseModel):
    items: list[AuditEntry]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = Field(ge=0)
    total_pages: int = Field(ge=0)

    @classmethod
    def from_record(cls, record: AuditPageRecord, *, page: int, page_size: int) -> Self:
        return cls(
            items=[AuditEntry.from_record(item) for item in record.items],
            page=page,
            page_size=page_size,
            total=record.total,
            total_pages=math.ceil(record.total / page_size),
        )
