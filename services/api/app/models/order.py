import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
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
    total_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Sum of line quantities (a snapshot, so order lists need no join).
    item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    payment_method: Mapped[PaymentMethod] = mapped_column(
        pg_enum(PaymentMethod, "payment_method"), nullable=False
    )
    recipient_name: Mapped[str] = mapped_column(String(255), nullable=False)
    recipient_phone: Mapped[str] = mapped_column(String(32), nullable=False)
    # Structured address as entered at checkout: ``lat``/``lon`` (WGS84, 6 decimals), street,
    # house, ... Orders placed before Yandex Go courier delivery have no coordinates.
    address_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    # Client-generated, unique per user. The request hash detects a key reused for another body.
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    idempotency_request_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        CheckConstraint("subtotal_uzs >= 0", name="subtotal_non_negative"),
        CheckConstraint("total_uzs >= 0", name="total_non_negative"),
        # New orders have total == subtotal (the customer pays the Yandex Go courier directly);
        # older orders' totals still include the delivery charge of the time.
        CheckConstraint("total_uzs >= subtotal_uzs", name="total_covers_subtotal"),
        # 0 only for an order whose every line ran out at picking (it is cancelled, ADR 0018).
        CheckConstraint("item_count >= 0", name="item_count_non_negative"),
        CheckConstraint(
            "status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')",
            name="cancelled_requires_reason",
        ),
        UniqueConstraint("user_id", "idempotency_key", name="uq_orders_user_id_idempotency_key"),
        # Customer history (newest first) and the operator queue by status.
        Index("ix_orders_user_id_created_at", "user_id", "created_at"),
        Index("ix_orders_status_created_at", "status", "created_at"),
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
    # Shortage at picking (ADR 0018): the quantity the customer ordered, set the first time staff
    # lower the line (``NULL``: never adjusted), and when the line was last lowered.
    original_quantity: Mapped[int | None] = mapped_column(Integer)
    adjusted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # 0 once the goods of the line ran out at picking.
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
        CheckConstraint(
            "original_quantity IS NULL OR original_quantity >= quantity",
            name="original_quantity_covers_quantity",
        ),
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


class OrderItemAdjustment(UUIDPrimaryKeyMixin, Base):
    """Append-only log of order lines lowered at picking because the goods were not there."""

    __tablename__ = "order_item_adjustments"

    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    order_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("order_items.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="SET NULL")
    )
    from_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    to_quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    # Staff free text; shown in the back office only (never to the customer, never logged).
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    # Whether the product's stock was set to 0 (the goods physically ran out) instead of the
    # difference being returned to stock.
    marked_out_of_stock: Mapped[bool] = mapped_column(Boolean, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    actor_role: Mapped[UserRole] = mapped_column(pg_enum(UserRole, "user_role"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "to_quantity >= 0 AND to_quantity < from_quantity", name="quantity_decreases"
        ),
        CheckConstraint("btrim(reason) <> ''", name="reason_not_blank"),
        Index("ix_order_item_adjustments_order_id_created_at", "order_id", "created_at"),
    )
