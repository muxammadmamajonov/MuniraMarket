import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.domain.order_status import OrderStatus
from app.models.enums import PaymentMethod, Unit, pg_enum


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
    payment_method: Mapped[PaymentMethod] = mapped_column(
        pg_enum(PaymentMethod, "payment_method"), nullable=False
    )
    recipient_name: Mapped[str] = mapped_column(String(255), nullable=False)
    recipient_phone: Mapped[str] = mapped_column(String(32), nullable=False)
    address_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), unique=True)

    __table_args__ = (
        CheckConstraint("subtotal_uzs >= 0", name="subtotal_non_negative"),
        CheckConstraint("delivery_fee_uzs >= 0", name="delivery_fee_non_negative"),
        CheckConstraint("total_uzs >= 0", name="total_non_negative"),
        CheckConstraint(
            "status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')",
            name="cancelled_requires_reason",
        ),
        Index("ix_orders_user_id", "user_id"),
        Index("ix_orders_status", "status"),
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

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price_uzs >= 0", name="unit_price_non_negative"),
        CheckConstraint("line_total_uzs >= 0", name="line_total_non_negative"),
        Index("ix_order_items_order_id", "order_id"),
    )
