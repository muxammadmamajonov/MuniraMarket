"""yandex go courier delivery: drop delivery zones, districts, fees and slots

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-13

The store no longer delivers or charges for delivery: a Yandex Go courier carries each order on
demand and the customer pays the courier. Delivery zones (whole Tashkent districts), delivery fees,
free-delivery thresholds, per-zone minimum orders and hours, and zone-linked delivery slots go.

Upgrade (one transaction):

1. ``orders``: add CHECK ``total_covers_subtotal`` (``total_uzs >= subtotal_uzs``), then drop
   ``total_is_sum`` (``total = subtotal + delivery_fee``) and ``delivery_fee_non_negative``. Every
   existing row already satisfies the new CHECK (it had ``fee >= 0`` and ``total = subtotal +
   fee``), and no row is updated: a historical order keeps the total it was charged, delivery
   included. New orders are written with ``total_uzs = subtotal_uzs`` by the application.
2. ``orders``: drop index ``ix_orders_delivery_slot_id``, the slot and zone foreign keys and the
   columns ``delivery_slot_id``, ``delivery_slot_date``, ``delivery_slot_starts_at``,
   ``delivery_slot_ends_at``, ``delivery_zone_id`` and ``delivery_fee_uzs``. The fee charged on a
   historical order stays recoverable as ``total_uzs - subtotal_uzs``.
3. Drop the tables ``delivery_slots``, ``delivery_zone_districts`` and ``delivery_zones``.
4. ``orders.address_snapshot`` (JSONB) is left as it is: new orders store ``lat``/``lon``; old
   snapshots keep their former keys, which the application ignores.

Data that is not recoverable after the upgrade: the zone/district/slot tables, each historical
order's zone and booked slot window.

Downgrade: recreate the three tables (empty) and the order columns (zone and slot columns
``NULL``), back-fill ``delivery_fee_uzs = total_uzs - subtotal_uzs`` (never negative, by the CHECK
above) and restore the old constraints and index. An order created after the upgrade then reads
as having had no delivery fee, which is what it was.
"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # --- 1. totals ----------------------------------------------------------------------------
    op.create_check_constraint(
        op.f("ck_orders_total_covers_subtotal"), "orders", "total_uzs >= subtotal_uzs"
    )
    op.drop_constraint(op.f("ck_orders_total_is_sum"), "orders", type_="check")
    op.drop_constraint(op.f("ck_orders_delivery_fee_non_negative"), "orders", type_="check")

    # --- 2. order columns ---------------------------------------------------------------------
    op.drop_index("ix_orders_delivery_slot_id", table_name="orders")
    op.drop_constraint(
        op.f("fk_orders_delivery_slot_id_delivery_slots"), "orders", type_="foreignkey"
    )
    op.drop_constraint(
        op.f("fk_orders_delivery_zone_id_delivery_zones"), "orders", type_="foreignkey"
    )
    op.drop_column("orders", "delivery_slot_ends_at")
    op.drop_column("orders", "delivery_slot_starts_at")
    op.drop_column("orders", "delivery_slot_date")
    op.drop_column("orders", "delivery_slot_id")
    op.drop_column("orders", "delivery_zone_id")
    op.drop_column("orders", "delivery_fee_uzs")

    # --- 3. tables ----------------------------------------------------------------------------
    op.drop_index("ix_delivery_slots_zone_id_slot_date", table_name="delivery_slots")
    op.drop_table("delivery_slots")
    op.drop_index("ix_delivery_zone_districts_zone_id", table_name="delivery_zone_districts")
    op.drop_table("delivery_zone_districts")
    op.drop_table("delivery_zones")


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


def downgrade() -> None:
    # --- tables (as created by 0003 and 0004), empty ------------------------------------------
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
    op.create_table(
        "delivery_slots",
        sa.Column("zone_id", sa.UUID(), nullable=False),
        sa.Column("slot_date", sa.Date(), nullable=False),
        sa.Column("starts_at", sa.Time(), nullable=False),
        sa.Column("ends_at", sa.Time(), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("reserved_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("cutoff_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        *_timestamps(),
        sa.CheckConstraint("starts_at < ends_at", name=op.f("ck_delivery_slots_times_ordered")),
        sa.CheckConstraint("capacity >= 0", name=op.f("ck_delivery_slots_capacity_non_negative")),
        sa.CheckConstraint(
            "reserved_count >= 0", name=op.f("ck_delivery_slots_reserved_non_negative")
        ),
        sa.CheckConstraint(
            "reserved_count <= capacity",
            name=op.f("ck_delivery_slots_reserved_within_capacity"),
        ),
        sa.ForeignKeyConstraint(
            ["zone_id"],
            ["delivery_zones.id"],
            name=op.f("fk_delivery_slots_zone_id_delivery_zones"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_delivery_slots")),
        sa.UniqueConstraint(
            "zone_id",
            "slot_date",
            "starts_at",
            name="uq_delivery_slots_zone_id_slot_date_starts_at",
        ),
    )
    op.create_index(
        "ix_delivery_slots_zone_id_slot_date",
        "delivery_slots",
        ["zone_id", "slot_date"],
        unique=False,
    )

    # --- order columns ------------------------------------------------------------------------
    # The fee charged is whatever the total holds beyond the goods (0 for courier-era orders).
    op.add_column("orders", sa.Column("delivery_fee_uzs", sa.BigInteger(), nullable=True))
    op.execute("UPDATE orders SET delivery_fee_uzs = total_uzs - subtotal_uzs")
    op.alter_column("orders", "delivery_fee_uzs", nullable=False)
    op.add_column("orders", sa.Column("delivery_zone_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_orders_delivery_zone_id_delivery_zones"),
        "orders",
        "delivery_zones",
        ["delivery_zone_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("orders", sa.Column("delivery_slot_id", sa.UUID(), nullable=True))
    op.add_column("orders", sa.Column("delivery_slot_date", sa.Date(), nullable=True))
    op.add_column("orders", sa.Column("delivery_slot_starts_at", sa.Time(), nullable=True))
    op.add_column("orders", sa.Column("delivery_slot_ends_at", sa.Time(), nullable=True))
    op.create_foreign_key(
        op.f("fk_orders_delivery_slot_id_delivery_slots"),
        "orders",
        "delivery_slots",
        ["delivery_slot_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_orders_delivery_slot_id", "orders", ["delivery_slot_id"], unique=False)

    # --- totals -------------------------------------------------------------------------------
    op.create_check_constraint(
        op.f("ck_orders_delivery_fee_non_negative"), "orders", "delivery_fee_uzs >= 0"
    )
    op.create_check_constraint(
        op.f("ck_orders_total_is_sum"), "orders", "total_uzs = subtotal_uzs + delivery_fee_uzs"
    )
    op.drop_constraint(op.f("ck_orders_total_covers_subtotal"), "orders", type_="check")
