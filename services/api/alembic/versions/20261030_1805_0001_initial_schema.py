"""initial schema: users, catalog, carts, orders

Revision ID: 0001
Revises:
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Native enums are created/dropped explicitly (create_type=False on the column types) because
# `unit` is shared by two tables.
LANGUAGE = postgresql.ENUM("uz", "ru", name="language", create_type=False)
USER_ROLE = postgresql.ENUM("customer", "operator", "admin", name="user_role", create_type=False)
ORDER_STATUS = postgresql.ENUM(
    "NEW",
    "CONFIRMED",
    "PICKING",
    "READY_FOR_DELIVERY",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    name="order_status",
    create_type=False,
)
PAYMENT_METHOD = postgresql.ENUM(
    "cash_on_delivery", "card_on_delivery", name="payment_method", create_type=False
)
UNIT = postgresql.ENUM("piece", "kg", "g", "l", "ml", name="unit", create_type=False)
ENUMS = (LANGUAGE, USER_ROLE, ORDER_STATUS, PAYMENT_METHOD, UNIT)


def upgrade() -> None:
    bind = op.get_bind()
    for enum in ENUMS:
        enum.create(bind, checkfirst=True)

    op.create_table(
        "categories",
        sa.Column("parent_id", sa.UUID(), nullable=True),
        sa.Column("slug", sa.String(length=128), nullable=False),
        sa.Column("name_uz", sa.String(length=255), nullable=False),
        sa.Column("name_ru", sa.String(length=255), nullable=False),
        sa.Column("image_url", sa.String(length=2048), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["categories.id"],
            name=op.f("fk_categories_parent_id_categories"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("slug", name=op.f("uq_categories_slug")),
    )
    op.create_index("ix_categories_parent_id", "categories", ["parent_id"], unique=False)
    op.create_table(
        "users",
        sa.Column("telegram_user_id", sa.BigInteger(), nullable=False),
        sa.Column("first_name", sa.String(length=255), nullable=False),
        sa.Column("last_name", sa.String(length=255), nullable=True),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("language", LANGUAGE, server_default=sa.text("'uz'"), nullable=False),
        sa.Column("role", USER_ROLE, server_default=sa.text("'customer'"), nullable=False),
        sa.Column("is_blocked", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("telegram_user_id", name=op.f("uq_users_telegram_user_id")),
    )
    op.create_table(
        "carts",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_carts_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_carts")),
        sa.UniqueConstraint("user_id", name=op.f("uq_carts_user_id")),
    )
    op.create_table(
        "orders",
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("status", ORDER_STATUS, server_default="NEW", nullable=False),
        sa.Column("subtotal_uzs", sa.BigInteger(), nullable=False),
        sa.Column("delivery_fee_uzs", sa.BigInteger(), nullable=False),
        sa.Column("total_uzs", sa.BigInteger(), nullable=False),
        sa.Column("payment_method", PAYMENT_METHOD, nullable=False),
        sa.Column("recipient_name", sa.String(length=255), nullable=False),
        sa.Column("recipient_phone", sa.String(length=32), nullable=False),
        sa.Column("address_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')",
            name=op.f("ck_orders_cancelled_requires_reason"),
        ),
        sa.CheckConstraint(
            "delivery_fee_uzs >= 0", name=op.f("ck_orders_delivery_fee_non_negative")
        ),
        sa.CheckConstraint("subtotal_uzs >= 0", name=op.f("ck_orders_subtotal_non_negative")),
        sa.CheckConstraint("total_uzs >= 0", name=op.f("ck_orders_total_non_negative")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_orders_user_id_users"), ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_orders_idempotency_key")),
        sa.UniqueConstraint("number", name=op.f("uq_orders_number")),
    )
    op.create_index("ix_orders_status", "orders", ["status"], unique=False)
    op.create_index("ix_orders_user_id", "orders", ["user_id"], unique=False)
    op.create_table(
        "products",
        sa.Column("category_id", sa.UUID(), nullable=False),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("slug", sa.String(length=160), nullable=False),
        sa.Column("name_uz", sa.String(length=255), nullable=False),
        sa.Column("name_ru", sa.String(length=255), nullable=False),
        sa.Column("description_uz", sa.Text(), nullable=True),
        sa.Column("description_ru", sa.Text(), nullable=True),
        sa.Column("brand", sa.String(length=128), nullable=True),
        sa.Column("unit", UNIT, nullable=False),
        sa.Column("price_uzs", sa.BigInteger(), nullable=False),
        sa.Column("old_price_uzs", sa.BigInteger(), nullable=True),
        sa.Column("stock_quantity", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "old_price_uzs IS NULL OR old_price_uzs >= 0",
            name=op.f("ck_products_old_price_non_negative"),
        ),
        sa.CheckConstraint("price_uzs >= 0", name=op.f("ck_products_price_non_negative")),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_products_category_id_categories"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
        sa.UniqueConstraint("sku", name=op.f("uq_products_sku")),
        sa.UniqueConstraint("slug", name=op.f("uq_products_slug")),
    )
    op.create_index("ix_products_category_id", "products", ["category_id"], unique=False)
    op.create_table(
        "cart_items",
        sa.Column("cart_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_cart_items_quantity_positive")),
        sa.ForeignKeyConstraint(
            ["cart_id"], ["carts.id"], name=op.f("fk_cart_items_cart_id_carts"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_cart_items_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cart_items")),
        sa.UniqueConstraint("cart_id", "product_id", name="uq_cart_items_cart_id_product_id"),
    )
    op.create_table(
        "order_items",
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=True),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("name_uz", sa.String(length=255), nullable=False),
        sa.Column("name_ru", sa.String(length=255), nullable=False),
        sa.Column("unit", UNIT, nullable=False),
        sa.Column("unit_price_uzs", sa.BigInteger(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("line_total_uzs", sa.BigInteger(), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "line_total_uzs >= 0", name=op.f("ck_order_items_line_total_non_negative")
        ),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_order_items_quantity_positive")),
        sa.CheckConstraint(
            "unit_price_uzs >= 0", name=op.f("ck_order_items_unit_price_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_items_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_order_items_product_id_products"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_items")),
    )
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_order_items_order_id", table_name="order_items")
    op.drop_table("order_items")
    op.drop_table("cart_items")
    op.drop_index("ix_products_category_id", table_name="products")
    op.drop_table("products")
    op.drop_index("ix_orders_user_id", table_name="orders")
    op.drop_index("ix_orders_status", table_name="orders")
    op.drop_table("orders")
    op.drop_table("carts")
    op.drop_table("users")
    op.drop_index("ix_categories_parent_id", table_name="categories")
    op.drop_table("categories")

    bind = op.get_bind()
    for enum in reversed(ENUMS):
        enum.drop(bind, checkfirst=True)
