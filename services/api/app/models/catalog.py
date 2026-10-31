import uuid
from datetime import datetime

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
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import Unit, pg_enum


class Category(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "categories"

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id", ondelete="RESTRICT")
    )
    slug: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    name_uz: Mapped[str] = mapped_column(String(255), nullable=False)
    name_ru: Mapped[str] = mapped_column(String(255), nullable=False)
    image_url: Mapped[str | None] = mapped_column(String(2048))
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )

    __table_args__ = (Index("ix_categories_parent_id", "parent_id"),)


class Product(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "products"

    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("categories.id", ondelete="RESTRICT"),
        nullable=False,
    )
    sku: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    name_uz: Mapped[str] = mapped_column(String(255), nullable=False)
    name_ru: Mapped[str] = mapped_column(String(255), nullable=False)
    description_uz: Mapped[str | None] = mapped_column(Text)
    description_ru: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(String(128))
    unit: Mapped[Unit] = mapped_column(pg_enum(Unit, "unit"), nullable=False)
    # Money is integer UZS. Never floats.
    price_uzs: Mapped[int] = mapped_column(BigInteger, nullable=False)
    old_price_uzs: Mapped[int | None] = mapped_column(BigInteger)
    # NULL means stock is not tracked for this product.
    stock_quantity: Mapped[int | None] = mapped_column(Integer)
    image_url: Mapped[str | None] = mapped_column(String(2048))
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    # Soft delete: an archived product is never shown or sold again, but order lines keep
    # pointing at it. Products are never hard-deleted.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("price_uzs >= 0", name="price_non_negative"),
        CheckConstraint("archived_at IS NULL OR NOT is_active", name="archived_is_inactive"),
        CheckConstraint(
            "old_price_uzs IS NULL OR old_price_uzs >= 0", name="old_price_non_negative"
        ),
        CheckConstraint("stock_quantity IS NULL OR stock_quantity >= 0", name="stock_non_negative"),
        Index("ix_products_category_id", "category_id"),
        # Catalog listing: active products, filtered by category.
        Index("ix_products_is_active_category_id", "is_active", "category_id"),
        # Trigram indexes back the ILIKE '%q%' catalog search (extension pg_trgm, migration 0002).
        Index(
            "ix_products_name_uz_trgm",
            "name_uz",
            postgresql_using="gin",
            postgresql_ops={"name_uz": "gin_trgm_ops"},
        ),
        Index(
            "ix_products_name_ru_trgm",
            "name_ru",
            postgresql_using="gin",
            postgresql_ops={"name_ru": "gin_trgm_ops"},
        ),
        Index(
            "ix_products_sku_trgm",
            "sku",
            postgresql_using="gin",
            postgresql_ops={"sku": "gin_trgm_ops"},
        ),
    )
