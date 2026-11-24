"""stock shortages: safety stock and order-line adjustments at picking (ADR 0018)

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-13

- ``products.safety_stock`` (INTEGER NOT NULL DEFAULT 0, ``>= 0``): units kept back for walk-in
  shoppers. The storefront sells ``stock_quantity - safety_stock`` (never below 0) of a tracked
  product; an untracked product (``stock_quantity`` NULL) is unaffected.
- ``order_items.original_quantity`` (INTEGER, NULL until the line is first adjusted; then the
  quantity the customer ordered, ``>= quantity``) and ``order_items.adjusted_at`` (TIMESTAMPTZ,
  NULL until adjusted).
- ``order_items`` quantity may now be 0 (a line whose goods ran out), and ``orders.item_count``
  may be 0 (an order whose every line ran out; it is cancelled in the same transaction).
- ``order_item_adjustments``: one row per shortage adjustment (who, when, from/to quantity,
  reason, whether the product was marked out of stock). Cascades with its order.

Additive on a populated database (existing products get ``safety_stock = 0``, existing lines
are unadjusted). The downgrade is lossy: it drops the adjustment log and the new columns, and
puts a line that was adjusted to 0 back to its original quantity (and an order with
``item_count = 0`` back to the sum of its lines) so the old ``> 0`` checks hold again; the
order's stored totals are left as they are.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column("safety_stock", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_products_safety_stock_non_negative"), "products", "safety_stock >= 0"
    )

    op.add_column("order_items", sa.Column("original_quantity", sa.Integer(), nullable=True))
    op.add_column(
        "order_items", sa.Column("adjusted_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.drop_constraint(op.f("ck_order_items_quantity_positive"), "order_items", type_="check")
    op.create_check_constraint(
        op.f("ck_order_items_quantity_non_negative"), "order_items", "quantity >= 0"
    )
    op.create_check_constraint(
        op.f("ck_order_items_original_quantity_covers_quantity"),
        "order_items",
        "original_quantity IS NULL OR original_quantity >= quantity",
    )
    op.drop_constraint(op.f("ck_orders_item_count_positive"), "orders", type_="check")
    op.create_check_constraint(
        op.f("ck_orders_item_count_non_negative"), "orders", "item_count >= 0"
    )

    op.create_table(
        "order_item_adjustments",
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("order_item_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=True),
        sa.Column("from_quantity", sa.Integer(), nullable=False),
        sa.Column("to_quantity", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("marked_out_of_stock", sa.Boolean(), nullable=False),
        sa.Column("actor_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "actor_role",
            postgresql.ENUM("customer", "operator", "admin", name="user_role", create_type=False),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "to_quantity >= 0 AND to_quantity < from_quantity",
            name=op.f("ck_order_item_adjustments_quantity_decreases"),
        ),
        sa.CheckConstraint(
            "btrim(reason) <> ''", name=op.f("ck_order_item_adjustments_reason_not_blank")
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_item_adjustments_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_order_item_adjustments_order_item_id_order_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_order_item_adjustments_product_id_products"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_order_item_adjustments_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_item_adjustments")),
    )
    op.create_index(
        "ix_order_item_adjustments_order_id_created_at",
        "order_item_adjustments",
        ["order_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_order_item_adjustments_order_id_created_at", table_name="order_item_adjustments"
    )
    op.drop_table("order_item_adjustments")

    # Lines that ran out to 0 get their original quantity back, so ``quantity > 0`` holds again.
    op.execute(
        "UPDATE order_items SET quantity = original_quantity, "
        "line_total_uzs = unit_price_uzs * original_quantity "
        "WHERE quantity = 0 AND original_quantity IS NOT NULL"
    )
    op.execute(
        "UPDATE orders o SET item_count = (SELECT sum(i.quantity) FROM order_items i "
        "WHERE i.order_id = o.id) WHERE o.item_count = 0"
    )
    op.drop_constraint(op.f("ck_orders_item_count_non_negative"), "orders", type_="check")
    op.create_check_constraint(op.f("ck_orders_item_count_positive"), "orders", "item_count > 0")
    op.drop_constraint(
        op.f("ck_order_items_original_quantity_covers_quantity"), "order_items", type_="check"
    )
    op.drop_constraint(op.f("ck_order_items_quantity_non_negative"), "order_items", type_="check")
    op.create_check_constraint(
        op.f("ck_order_items_quantity_positive"), "order_items", "quantity > 0"
    )
    op.drop_column("order_items", "adjusted_at")
    op.drop_column("order_items", "original_quantity")

    op.drop_constraint(op.f("ck_products_safety_stock_non_negative"), "products", type_="check")
    op.drop_column("products", "safety_stock")
