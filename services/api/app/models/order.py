import uuid
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.domain.order_status import OrderStatus
from app.models.enums import PaymentMethod, Unit, UserRole, pg_enum


class Order(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "orders"

    number: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[OrderStatus] = mapped_column(
        pg_enum(OrderStatus, "order_status"),
        nullable=False,
        default=OrderStatus.NEW,
        server_default=OrderStatus.NEW.value,
    )
    subtotal_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    delivery_fee_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    total_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Sum of line quantities (a snapshot, so order lists need no join).
    item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    payment_method: Mapped[PaymentMethod] = mapped_column(
        pg_enum(PaymentMethod, "payment_method"), nullable=False
    )
    delivery_zone_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("delivery_zones.id", ondelete="SET NULL")
    )
    # The booked delivery window (``delivery_slots``), plus a snapshot of it so the order stays
    # readable if the slot is later edited. NULL when the zone had no slots.
    delivery_slot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("delivery_slots.id", ondelete="RESTRICT")
    )
    delivery_slot_date: Mapped[date | None] = mapped_column(Date())
    delivery_slot_starts_at: Mapped[time | None] = mapped_column(Time())
    delivery_slot_ends_at: Mapped[time | None] = mapped_column(Time())
    recipient_name: Mapped[str] = mapped_column(String(255), nullable=False)
    recipient_phone: Mapped[str] = mapped_column(String(32), nullable=False)
    # Structured address as entered at checkout (district code, street, house, ...).
    address_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    # Client-generated, unique per user. The request hash detects a key reused for another body.
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    idempotency_request_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        CheckConstraint("subtotal_uzs >= 0", name="subtotal_non_negative"),
        CheckConstraint("delivery_fee_uzs >= 0", name="delivery_fee_non_negative"),
        CheckConstraint("total_uzs >= 0", name="total_non_negative"),
        CheckConstraint("total_uzs = subtotal_uzs + delivery_fee_uzs", name="total_is_sum"),
        CheckConstraint("item_count > 0", name="item_count_positive"),
        CheckConstraint(
            "status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')",
            name="cancelled_requires_reason",
        ),
        UniqueConstraint("user_id", "idempotency_key", name="uq_orders_user_id_idempotency_key"),
        # Customer history (newest first) and the operator queue by status.
        Index("ix_orders_user_id_created_at", "user_id", "created_at"),
        Index("ix_orders_status_created_at", "status", "created_at"),
        Index("ix_orders_delivery_slot_id", "delivery_slot_id"),
        # Dashboard: today's orders by creation time.
        Index("ix_orders_created_at", "created_at"),
    )


class OrderItem(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "order_items"

    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="SET NULL")
    )
    # Snapshots: an order must stay readable after the catalog changes.
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    name_uz: Mapped[str] = mapped_column(String(255), nullable=False)
    name_ru: Mapped[str] = mapped_column(String(255), nullable=False)
    unit: Mapped[Unit] = mapped_column(pg_enum(Unit, "unit"), nullable=False)
    unit_price_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    line_total_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Whether placing the order decremented tracked stock (so cancelling returns exactly that).
    stock_decremented: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price_uzs >= 0", name="unit_price_non_negative"),
        CheckConstraint("line_total_uzs >= 0", name="line_total_non_negative"),
        CheckConstraint("line_total_uzs = unit_price_uzs * quantity", name="line_total_is_product"),
        Index("ix_order_items_order_id", "order_id"),
    )


class OrderStatusHistory(UUIDPrimaryKeyMixin, Base):
    """Append-only audit of every status an order entered, including creation (``from`` NULL)."""

    __tablename__ = "order_status_history"

    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    from_status: Mapped[OrderStatus | None] = mapped_column(pg_enum(OrderStatus, "order_status"))
    to_status: Mapped[OrderStatus] = mapped_column(
        pg_enum(OrderStatus, "order_status"), nullable=False
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    actor_role: Mapped[UserRole] = mapped_column(pg_enum(UserRole, "user_role"), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("from_status IS NULL OR from_status <> to_status", name="status_changes"),
        Index("ix_order_status_history_order_id_created_at", "order_id", "created_at"),
    )
