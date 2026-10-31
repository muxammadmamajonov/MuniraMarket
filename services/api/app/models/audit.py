import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin
from app.models.enums import UserRole, pg_enum


class AuditLog(UUIDPrimaryKeyMixin, Base):
    """Append-only record of back-office changes (a database trigger rejects UPDATE and DELETE).

    Written only through ``app.audit.record_audit`` in the same transaction as the change.
    ``details`` holds allow-listed, scalar, non-personal values only (never phone numbers,
    addresses, names, free-text reasons, Telegram ``initData``, cookies or tokens).
    """

    __tablename__ = "audit_log"

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    actor_role: Mapped[UserRole] = mapped_column(pg_enum(UserRole, "user_role"), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    __table_args__ = (
        Index("ix_audit_log_created_at", "created_at"),
        Index("ix_audit_log_entity_type_entity_id", "entity_type", "entity_id"),
        Index("ix_audit_log_actor_user_id", "actor_user_id"),
    )
