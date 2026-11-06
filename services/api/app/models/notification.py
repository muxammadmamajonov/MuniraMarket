import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin


class NotificationOutbox(UUIDPrimaryKeyMixin, Base):
    """Transactional outbox (ADR 0008).

    A row is written in the same transaction as the order change it describes, so a notification
    exists if and only if the change committed. A transport (Telegram Serverless today) claims
    pending rows with a lease and reports the outcome; nothing here talks to Telegram.
    """

    __tablename__ = "notification_outbox"

    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE")
    )
    # Everything the transport needs to render and address the message. No address or phone.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Not before this instant (retry backoff).
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Claimed by a transport until this instant; expired leases are claimable again.
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    # Set once the row is finished: ``delivered``, ``recipient_blocked`` or ``failed``.
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(32))
    # A short machine code from the transport (never message text or user data).
    last_error: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        CheckConstraint("(processed_at IS NULL) = (outcome IS NULL)", name="outcome_iff_processed"),
        Index(
            "ix_notification_outbox_pending",
            "available_at",
            postgresql_where=text("processed_at IS NULL"),
        ),
        Index("ix_notification_outbox_order_id", "order_id"),
    )


class StaffNotificationChat(Base):
    """The one Telegram group that receives staff order alerts (``/connect_orders``, ADR 0015).

    A single row (``id = 1``). Written only through the service-signed internal route after the
    acting Telegram user was checked to be an ``admin`` in this database; never exposed by a
    public or back-office route, never sent to a browser.
    """

    __tablename__ = "staff_notification_chat"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False, default=1)
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    connected_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        # Telegram group and supergroup ids are negative.
        CheckConstraint("chat_id < 0", name="group_chat_id"),
    )
