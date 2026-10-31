import uuid
from datetime import time

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Time,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class DeliveryZone(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A priced delivery area made of whole Tashkent districts (``delivery_zone_districts``)."""

    __tablename__ = "delivery_zones"

    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name_uz: Mapped[str] = mapped_column(String(255), nullable=False)
    name_ru: Mapped[str] = mapped_column(String(255), nullable=False)
    # Money is integer UZS.
    delivery_fee_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # NULL: delivery in this zone is never free.
    free_delivery_threshold_uzs: Mapped[int | None] = mapped_column(BigInteger)
    min_order_uzs: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    # Local Asia/Tashkent working hours.
    opens_at: Mapped[time] = mapped_column(Time(), nullable=False)
    closes_at: Mapped[time] = mapped_column(Time(), nullable=False)
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    __table_args__ = (
        CheckConstraint("delivery_fee_uzs >= 0", name="delivery_fee_non_negative"),
        CheckConstraint(
            "free_delivery_threshold_uzs IS NULL OR free_delivery_threshold_uzs >= 0",
            name="free_threshold_non_negative",
        ),
        CheckConstraint("min_order_uzs >= 0", name="min_order_non_negative"),
        CheckConstraint("opens_at < closes_at", name="hours_ordered"),
    )


class DeliveryZoneDistrict(Base):
    """District -> zone. The district is the primary key, so a district is in at most one zone."""

    __tablename__ = "delivery_zone_districts"

    district: Mapped[str] = mapped_column(String(32), primary_key=True)
    zone_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("delivery_zones.id", ondelete="CASCADE"),
        nullable=False,
    )

    __table_args__ = (Index("ix_delivery_zone_districts_zone_id", "zone_id"),)
