"""profile hub: birth date, user-edited name and saved delivery addresses

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-13

- ``users.birth_date`` (DATE, NULL): optional, edited in the shop profile (``PATCH /me``).
- ``users.name_edited_at`` (TIMESTAMPTZ, NULL): set when the user edits their name in the shop;
  from then on a Telegram sign-in no longer overwrites ``first_name`` / ``last_name``.
- ``user_addresses``: the customer's saved delivery addresses (at most 10 per user, enforced by
  the API), the same fields as an order's delivery address plus an optional label. Owned by the
  user (``ON DELETE CASCADE``); at most one default per user (partial unique index).

Additive only (nullable columns and a new table): safe on a populated database. The downgrade
drops the table and both columns; saved addresses, birth dates and the "name edited" marks are
lost (placed orders keep their own address snapshots).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("birth_date", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("name_edited_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "user_addresses",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("label", sa.String(length=32), nullable=True),
        sa.Column("lat", sa.Double(), nullable=False),
        sa.Column("lon", sa.Double(), nullable=False),
        sa.Column("street", sa.String(length=200), nullable=False),
        sa.Column("house", sa.String(length=32), nullable=False),
        sa.Column("apartment", sa.String(length=16), nullable=True),
        sa.Column("entrance", sa.String(length=16), nullable=True),
        sa.Column("floor", sa.String(length=8), nullable=True),
        sa.Column("landmark", sa.String(length=200), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
        sa.CheckConstraint("lat BETWEEN -90 AND 90", name=op.f("ck_user_addresses_lat_range")),
        sa.CheckConstraint("lon BETWEEN -180 AND 180", name=op.f("ck_user_addresses_lon_range")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_addresses_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_addresses")),
    )
    op.create_index("ix_user_addresses_user_id", "user_addresses", ["user_id"], unique=False)
    op.create_index(
        "uq_user_addresses_user_id_default",
        "user_addresses",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_user_addresses_user_id_default",
        table_name="user_addresses",
        postgresql_where=sa.text("is_default"),
    )
    op.drop_index("ix_user_addresses_user_id", table_name="user_addresses")
    op.drop_table("user_addresses")
    op.drop_column("users", "name_edited_at")
    op.drop_column("users", "birth_date")
