"""checkout: delivery zones, order lifecycle (status history), notification outbox

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-31

- ``delivery_zones`` + ``delivery_zone_districts`` (a district belongs to at most one zone).
- ``orders``: ``delivery_zone_id``, ``item_count``, a per-user ``Idempotency-Key`` (unique on
  ``(user_id, idempotency_key)`` instead of globally) with the request hash, ``total = subtotal +
  fee`` and listing indexes. ``order_items``: ``line_total = unit_price * quantity`` and
  ``stock_decremented`` (what a cancellation may return).
- ``order_status_history`` (append-only audit) and ``notification_outbox`` (ADR 0008).

No order could be created before this revision, but the upgrade still back-fills the new NOT NULL
columns so it is safe on a table that has rows. The downgrade drops the new tables and columns and
restores the global idempotency-key constraint (legacy keys are cleared first, as they are only
unique per user).
"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Existing types (created in 0001); never created or dropped here.
ORDER_STATUS = postgresql.ENUM(name="order_status", create_type=False)
USER_ROLE = postgresql.ENUM(name="user_role", create_type=False)


def _timestamps() -> list[sa.Column[datetime]]:
    return [
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
    ]


def upgrade() -> None:
    op.create_table(
        "delivery_zones",
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("name_uz", sa.String(length=255), nullable=False),
        sa.Column("name_ru", sa.String(length=255), nullable=False),
        sa.Column("delivery_fee_uzs", sa.BigInteger(), nullable=False),
        sa.Column("free_delivery_threshold_uzs", sa.BigInteger(), nullable=True),
        sa.Column("min_order_uzs", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("opens_at", sa.Time(), nullable=False),
        sa.Column("closes_at", sa.Time(), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "delivery_fee_uzs >= 0", name=op.f("ck_delivery_zones_delivery_fee_non_negative")
        ),
        sa.CheckConstraint(
            "free_delivery_threshold_uzs IS NULL OR free_delivery_threshold_uzs >= 0",
            name=op.f("ck_delivery_zones_free_threshold_non_negative"),
        ),
        sa.CheckConstraint(
            "min_order_uzs >= 0", name=op.f("ck_delivery_zones_min_order_non_negative")
        ),
        sa.CheckConstraint("opens_at < closes_at", name=op.f("ck_delivery_zones_hours_ordered")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_delivery_zones")),
        sa.UniqueConstraint("slug", name=op.f("uq_delivery_zones_slug")),
    )
    op.create_table(
        "delivery_zone_districts",
        sa.Column("district", sa.String(length=32), nullable=False),
        sa.Column("zone_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["zone_id"],
            ["delivery_zones.id"],
            name=op.f("fk_delivery_zone_districts_zone_id_delivery_zones"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("district", name=op.f("pk_delivery_zone_districts")),
    )
    op.create_index(
        "ix_delivery_zone_districts_zone_id", "delivery_zone_districts", ["zone_id"], unique=False
    )

    # --- orders -------------------------------------------------------------------------------
    op.add_column("orders", sa.Column("delivery_zone_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_orders_delivery_zone_id_delivery_zones"),
        "orders",
        "delivery_zones",
        ["delivery_zone_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "orders",
        sa.Column("item_count", sa.Integer(), server_default=sa.text("1"), nullable=False),
    )
    op.execute(
        "UPDATE orders SET item_count = GREATEST(1, COALESCE("
        "(SELECT sum(quantity) FROM order_items WHERE order_items.order_id = orders.id), 1))"
    )
    op.alter_column("orders", "item_count", server_default=None)
    op.create_check_constraint(op.f("ck_orders_item_count_positive"), "orders", "item_count > 0")
    op.create_check_constraint(
        op.f("ck_orders_total_is_sum"), "orders", "total_uzs = subtotal_uzs + delivery_fee_uzs"
    )

    op.drop_constraint(op.f("uq_orders_idempotency_key"), "orders", type_="unique")
    op.execute("UPDATE orders SET idempotency_key = 'legacy-' || id WHERE idempotency_key IS NULL")
    op.alter_column("orders", "idempotency_key", nullable=False)
    op.add_column(
        "orders",
        sa.Column(
            "idempotency_request_hash", sa.String(length=64), server_default="", nullable=False
        ),
    )
    op.alter_column("orders", "idempotency_request_hash", server_default=None)
    op.create_unique_constraint(
        "uq_orders_user_id_idempotency_key", "orders", ["user_id", "idempotency_key"]
    )

    op.drop_index("ix_orders_user_id", table_name="orders")
    op.drop_index("ix_orders_status", table_name="orders")
    op.create_index(
        "ix_orders_user_id_created_at", "orders", ["user_id", "created_at"], unique=False
    )
    op.create_index("ix_orders_status_created_at", "orders", ["status", "created_at"], unique=False)

    op.add_column(
        "order_items",
        sa.Column(
            "stock_decremented", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
    )
    op.create_check_constraint(
        op.f("ck_order_items_line_total_is_product"),
        "order_items",
        "line_total_uzs = unit_price_uzs * quantity",
    )

    # --- history and outbox -------------------------------------------------------------------
    op.create_table(
        "order_status_history",
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("from_status", ORDER_STATUS, nullable=True),
        sa.Column("to_status", ORDER_STATUS, nullable=False),
        sa.Column("actor_user_id", sa.UUID(), nullable=True),
        sa.Column("actor_role", USER_ROLE, nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "from_status IS NULL OR from_status <> to_status",
            name=op.f("ck_order_status_history_status_changes"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_order_status_history_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_status_history_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_status_history")),
    )
    op.create_index(
        "ix_order_status_history_order_id_created_at",
        "order_status_history",
        ["order_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "notification_outbox",
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("order_id", sa.UUID(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("outcome", sa.String(length=32), nullable=True),
        sa.Column("last_error", sa.String(length=64), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "attempts >= 0", name=op.f("ck_notification_outbox_attempts_non_negative")
        ),
        sa.CheckConstraint(
            "(processed_at IS NULL) = (outcome IS NULL)",
            name=op.f("ck_notification_outbox_outcome_iff_processed"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_notification_outbox_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification_outbox")),
    )
    op.create_index(
        "ix_notification_outbox_pending",
        "notification_outbox",
        ["available_at"],
        unique=False,
        postgresql_where=sa.text("processed_at IS NULL"),
    )
    op.create_index(
        "ix_notification_outbox_order_id", "notification_outbox", ["order_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_notification_outbox_order_id", table_name="notification_outbox")
    op.drop_index(
        "ix_notification_outbox_pending",
        table_name="notification_outbox",
        postgresql_where=sa.text("processed_at IS NULL"),
    )
    op.drop_table("notification_outbox")
    op.drop_index("ix_order_status_history_order_id_created_at", table_name="order_status_history")
    op.drop_table("order_status_history")

    op.drop_constraint(op.f("ck_order_items_line_total_is_product"), "order_items", type_="check")
    op.drop_column("order_items", "stock_decremented")

    op.drop_index("ix_orders_status_created_at", table_name="orders")
    op.drop_index("ix_orders_user_id_created_at", table_name="orders")
    op.create_index("ix_orders_status", "orders", ["status"], unique=False)
    op.create_index("ix_orders_user_id", "orders", ["user_id"], unique=False)

    op.drop_constraint("uq_orders_user_id_idempotency_key", "orders", type_="unique")
    op.drop_column("orders", "idempotency_request_hash")
    op.alter_column("orders", "idempotency_key", nullable=True)
    # Keys were unique per user only; the old constraint is global, so they cannot all be kept.
    op.execute("UPDATE orders SET idempotency_key = NULL")
    op.create_unique_constraint(op.f("uq_orders_idempotency_key"), "orders", ["idempotency_key"])

    op.drop_constraint(op.f("ck_orders_total_is_sum"), "orders", type_="check")
    op.drop_constraint(op.f("ck_orders_item_count_positive"), "orders", type_="check")
    op.drop_column("orders", "item_count")
    op.drop_constraint(
        op.f("fk_orders_delivery_zone_id_delivery_zones"), "orders", type_="foreignkey"
    )
    op.drop_column("orders", "delivery_zone_id")

    op.drop_index("ix_delivery_zone_districts_zone_id", table_name="delivery_zone_districts")
    op.drop_table("delivery_zone_districts")
    op.drop_table("delivery_zones")
