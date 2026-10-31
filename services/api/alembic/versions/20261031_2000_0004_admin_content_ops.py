"""admin content operations: product soft delete + sort order, delivery slots, audit log

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-31

- ``products``: ``sort_order`` and ``archived_at`` (soft delete; an archived product is inactive,
  enforced by ``ck_products_archived_is_inactive``). Products are never hard-deleted, so order
  snapshots and ``order_items.product_id`` stay intact.
- ``delivery_slots``: bookable windows per zone and local date with ``capacity`` and
  ``reserved_count`` (``reserved_count <= capacity`` is a CHECK, the oversell backstop).
- ``orders``: ``delivery_slot_id`` (RESTRICT) plus a date/time snapshot of the booked window, and a
  ``created_at`` index for the dashboard.
- ``audit_log``: append-only (a trigger rejects UPDATE and DELETE).

The upgrade is safe on populated tables (all new columns are nullable or have defaults). The
downgrade drops everything added here; archived products stay inactive.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Existing type (created in 0001); never created or dropped here.
USER_ROLE = postgresql.ENUM(name="user_role", create_type=False)

# The trigger function is unqualified on purpose: it is created in the first schema of the
# search_path, like every table here. Static SQL only (no string formatting).
_CREATE_REJECT_FUNCTION = """
CREATE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only'
        USING ERRCODE = 'insufficient_privilege';
END
$$
"""
_CREATE_REJECT_TRIGGER = (
    "CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log "
    "FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change()"
)
_DROP_REJECT_TRIGGER = "DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log"
_DROP_REJECT_FUNCTION = "DROP FUNCTION IF EXISTS audit_log_reject_change()"


def upgrade() -> None:
    # --- products -----------------------------------------------------------------------------
    op.add_column(
        "products",
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column("products", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_products_archived_is_inactive"),
        "products",
        "archived_at IS NULL OR NOT is_active",
    )

    # --- delivery slots -----------------------------------------------------------------------
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

    # --- orders -------------------------------------------------------------------------------
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
    op.create_index("ix_orders_created_at", "orders", ["created_at"], unique=False)

    # --- audit log ----------------------------------------------------------------------------
    op.create_table(
        "audit_log",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("actor_user_id", sa.UUID(), nullable=True),
        sa.Column("actor_role", USER_ROLE, nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_audit_log_actor_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_log")),
    )
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"], unique=False)
    op.create_index(
        "ix_audit_log_entity_type_entity_id",
        "audit_log",
        ["entity_type", "entity_id"],
        unique=False,
    )
    op.create_index("ix_audit_log_actor_user_id", "audit_log", ["actor_user_id"], unique=False)
    op.execute(_CREATE_REJECT_FUNCTION)
    op.execute(_CREATE_REJECT_TRIGGER)


def downgrade() -> None:
    op.execute(_DROP_REJECT_TRIGGER)
    op.execute(_DROP_REJECT_FUNCTION)
    op.drop_index("ix_audit_log_actor_user_id", table_name="audit_log")
    op.drop_index("ix_audit_log_entity_type_entity_id", table_name="audit_log")
    op.drop_index("ix_audit_log_created_at", table_name="audit_log")
    op.drop_table("audit_log")

    op.drop_index("ix_orders_created_at", table_name="orders")
    op.drop_index("ix_orders_delivery_slot_id", table_name="orders")
    op.drop_constraint(
        op.f("fk_orders_delivery_slot_id_delivery_slots"), "orders", type_="foreignkey"
    )
    op.drop_column("orders", "delivery_slot_ends_at")
    op.drop_column("orders", "delivery_slot_starts_at")
    op.drop_column("orders", "delivery_slot_date")
    op.drop_column("orders", "delivery_slot_id")

    op.drop_index("ix_delivery_slots_zone_id_slot_date", table_name="delivery_slots")
    op.drop_table("delivery_slots")

    op.drop_constraint(op.f("ck_products_archived_is_inactive"), "products", type_="check")
    op.drop_column("products", "archived_at")
    op.drop_column("products", "sort_order")
