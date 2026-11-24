import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Double,
    ForeignKey,
    Index,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class UserAddress(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A delivery address the customer saved in their profile (at most 10 per user).

    The same fields as an order's ``DeliveryAddress`` plus an optional label. At most one row per
    user is the default (partial unique index); checkout copies a saved address into the order's
    own snapshot, so editing or deleting it never changes a placed order.
    """

    __tablename__ = "user_addresses"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(32))
    # WGS84, rounded to 6 decimals by the API.
    lat: Mapped[float] = mapped_column(Double, nullable=False)
    lon: Mapped[float] = mapped_column(Double, nullable=False)
    street: Mapped[str] = mapped_column(String(200), nullable=False)
    house: Mapped[str] = mapped_column(String(32), nullable=False)
    apartment: Mapped[str | None] = mapped_column(String(16))
    entrance: Mapped[str | None] = mapped_column(String(16))
    floor: Mapped[str | None] = mapped_column(String(8))
    landmark: Mapped[str | None] = mapped_column(String(200))
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    __table_args__ = (
        CheckConstraint("lat BETWEEN -90 AND 90", name="lat_range"),
        CheckConstraint("lon BETWEEN -180 AND 180", name="lon_range"),
        Index("ix_user_addresses_user_id", "user_id"),
        # At most one default address per user.
        Index(
            "uq_user_addresses_user_id_default",
            "user_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )
