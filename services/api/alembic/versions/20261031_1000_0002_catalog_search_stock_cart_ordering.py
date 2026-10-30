"""catalog search (pg_trgm), stock check, product image, cart line ordering

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-31

- ``pg_trgm`` + GIN trigram indexes on ``products.name_uz``, ``name_ru`` and ``sku`` back the
  catalog ``ILIKE '%q%'`` search.
- ``products.stock_quantity`` can never be negative (``NULL`` still means "not tracked").
- ``products.image_url`` (nullable) and a ``(is_active, category_id)`` listing index.
- ``cart_items.created_at`` keeps cart lines in the order they were added.

The downgrade leaves the ``pg_trgm`` extension installed: extensions are database-wide, may be
shared with other objects, and dropping one is not part of undoing this schema change.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TRIGRAM_COLUMNS = ("name_uz", "name_ru", "sku")


def upgrade() -> None:
    # pg_trgm is a "trusted" extension (PostgreSQL 13+): the database owner may create it.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.add_column("products", sa.Column("image_url", sa.String(length=2048), nullable=True))
    op.create_check_constraint(
        op.f("ck_products_stock_non_negative"),
        "products",
        "stock_quantity IS NULL OR stock_quantity >= 0",
    )
    op.create_index(
        "ix_products_is_active_category_id", "products", ["is_active", "category_id"], unique=False
    )
    for column in TRIGRAM_COLUMNS:
        op.create_index(
            f"ix_products_{column}_trgm",
            "products",
            [column],
            unique=False,
            postgresql_using="gin",
            postgresql_ops={column: "gin_trgm_ops"},
        )

    op.add_column(
        "cart_items",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("cart_items", "created_at")

    for column in reversed(TRIGRAM_COLUMNS):
        op.drop_index(f"ix_products_{column}_trgm", table_name="products")
    op.drop_index("ix_products_is_active_category_id", table_name="products")
    op.drop_constraint(op.f("ck_products_stock_non_negative"), "products", type_="check")
    op.drop_column("products", "image_url")
