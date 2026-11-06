"""security state in PostgreSQL (Redis removed), OIDC login states, staff order group

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-06

- ``auth_sessions``: browser sessions and rotation tombstones keyed by ``sha256(token)``
  (ADR 0007, ADR 0013). ``user_id`` (indexed, no foreign key) only on live records.
- ``rate_limit_counters``: fixed-window counters, one row per ``scope:subject:window``.
- ``service_request_nonces``: ADR 0003 replay protection, primary key ``(key_id, nonce)``.
- ``oidc_login_states``: one-time Telegram OIDC login state (ADR 0014).
- ``staff_notification_chat``: the single Telegram group for staff order alerts (ADR 0015).

Every security table has an ``expires_at`` index for the cleanup job; readers filter on
``expires_at`` themselves, so cleanup only reclaims space. All tables are new and empty, so the
upgrade is safe on a populated database; the downgrade drops them (everyone signs in again).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("record", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "token_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_auth_sessions_token_hash_hex")
        ),
        sa.PrimaryKeyConstraint("token_hash", name=op.f("pk_auth_sessions")),
    )
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])

    op.create_table(
        "rate_limit_counters",
        sa.Column("bucket", sa.String(length=200), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("hits > 0", name=op.f("ck_rate_limit_counters_hits_positive")),
        sa.PrimaryKeyConstraint("bucket", name=op.f("pk_rate_limit_counters")),
    )
    op.create_index("ix_rate_limit_counters_expires_at", "rate_limit_counters", ["expires_at"])

    op.create_table(
        "service_request_nonces",
        sa.Column("key_id", sa.String(length=32), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key_id", "nonce", name="pk_service_request_nonces"),
    )
    op.create_index(
        "ix_service_request_nonces_expires_at", "service_request_nonces", ["expires_at"]
    )

    op.create_table(
        "oidc_login_states",
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("binding_hash", sa.String(length=64), nullable=False),
        sa.Column("entrance", sa.String(length=16), nullable=False),
        sa.Column("code_verifier", sa.String(length=128), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("return_to", sa.String(length=512), nullable=False),
        sa.Column("created_at_epoch", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "entrance IN ('storefront', 'admin')", name=op.f("ck_oidc_login_states_entrance_known")
        ),
        sa.PrimaryKeyConstraint("state_hash", name=op.f("pk_oidc_login_states")),
    )
    op.create_index("ix_oidc_login_states_expires_at", "oidc_login_states", ["expires_at"])

    op.create_table(
        "staff_notification_chat",
        sa.Column("id", sa.SmallInteger(), autoincrement=False, nullable=False),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("connected_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "connected_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name=op.f("ck_staff_notification_chat_single_row")),
        sa.CheckConstraint("chat_id < 0", name=op.f("ck_staff_notification_chat_group_chat_id")),
        sa.ForeignKeyConstraint(
            ["connected_by_user_id"],
            ["users.id"],
            name=op.f("fk_staff_notification_chat_connected_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_staff_notification_chat")),
    )


def downgrade() -> None:
    op.drop_table("staff_notification_chat")
    op.drop_index("ix_oidc_login_states_expires_at", table_name="oidc_login_states")
    op.drop_table("oidc_login_states")
    op.drop_index("ix_service_request_nonces_expires_at", table_name="service_request_nonces")
    op.drop_table("service_request_nonces")
    op.drop_index("ix_rate_limit_counters_expires_at", table_name="rate_limit_counters")
    op.drop_table("rate_limit_counters")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_expires_at", table_name="auth_sessions")
    op.drop_table("auth_sessions")
