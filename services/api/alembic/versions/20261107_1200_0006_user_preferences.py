"""user preferences: confirmed language and Telegram-attested phone

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-07

One canonical place for each preference, read by the bot, the storefront and the admin:

- ``users.language`` (existing) stays the single language value. ``language_confirmed_at`` is
  set when the user explicitly chose it (bot onboarding or the storefront profile); while it is
  ``NULL`` the bot asks once on ``/start``.
- ``users.phone`` (existing, never exposed to clients) gets ``phone_verified_at`` and
  ``phone_verification_method``. ``telegram_contact`` means the user shared their OWN Telegram
  contact with the bot (``contact.user_id == from.id``), which Telegram ties to the account's
  number; ``otp`` is reserved for a code-based provider (Telegram Gateway), off by default.

Additive, nullable columns only: safe on a populated table. The downgrade drops them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("language_confirmed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("phone_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("phone_verification_method", sa.String(length=32), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_users_phone_verification_method_known"),
        "users",
        "phone_verification_method IS NULL "
        "OR phone_verification_method IN ('telegram_contact', 'otp')",
    )
    op.create_check_constraint(
        op.f("ck_users_phone_verified_consistent"),
        "users",
        "(phone_verified_at IS NULL AND phone_verification_method IS NULL) "
        "OR (phone_verified_at IS NOT NULL AND phone_verification_method IS NOT NULL "
        "AND phone IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_users_phone_verified_consistent"), "users", type_="check")
    op.drop_constraint(op.f("ck_users_phone_verification_method_known"), "users", type_="check")
    op.drop_column("users", "phone_verification_method")
    op.drop_column("users", "phone_verified_at")
    op.drop_column("users", "language_confirmed_at")
