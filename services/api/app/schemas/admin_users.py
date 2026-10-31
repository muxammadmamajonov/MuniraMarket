"""Admin user management request/response models. Phone numbers are never part of them."""

import math
import uuid
from datetime import datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import Language, UserRole
from app.repositories.admin_users import AdminUserPageRecord, AdminUserRecord


class AdminUser(BaseModel):
    id: uuid.UUID
    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language: Language
    role: UserRole
    is_blocked: bool
    created_at: datetime

    @classmethod
    def from_record(cls, record: AdminUserRecord) -> Self:
        return cls(
            id=record.id,
            telegram_user_id=record.telegram_user_id,
            first_name=record.first_name,
            last_name=record.last_name,
            username=record.username,
            language=record.language,
            role=record.role,
            is_blocked=record.is_blocked,
            created_at=record.created_at,
        )


class AdminUserPage(BaseModel):
    items: list[AdminUser]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = Field(ge=0)
    total_pages: int = Field(ge=0)

    @classmethod
    def from_record(cls, record: AdminUserPageRecord, *, page: int, page_size: int) -> Self:
        return cls(
            items=[AdminUser.from_record(item) for item in record.items],
            page=page,
            page_size=page_size,
            total=record.total,
            total_pages=math.ceil(record.total / page_size),
        )


class UserUpdateRequest(BaseModel):
    """Send ``role``, ``is_blocked`` or both; neither may be ``null``."""

    model_config = ConfigDict(extra="forbid")

    role: UserRole | None = None
    is_blocked: bool | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("send role and/or is_blocked")
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self
