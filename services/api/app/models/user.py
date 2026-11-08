from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import Language, UserRole, pg_enum


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"

    telegram_user_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    first_name: Mapped[str] = mapped_column(String(255), nullable=False)
    last_name: Mapped[str | None] = mapped_column(String(255))
    username: Mapped[str | None] = mapped_column(String(64))
    phone: Mapped[str | None] = mapped_column(String(32))
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # ``telegram_contact`` (own contact shared with the bot) or ``otp`` (code provider).
    phone_verification_method: Mapped[str | None] = mapped_column(String(32))
    language: Mapped[Language] = mapped_column(
        pg_enum(Language, "language"),
        nullable=False,
        default=Language.UZ,
        server_default=text("'uz'"),
    )
    # Set when the user explicitly chose ``language`` (bot onboarding or the shop profile).
    language_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    role: Mapped[UserRole] = mapped_column(
        pg_enum(UserRole, "user_role"),
        nullable=False,
        default=UserRole.CUSTOMER,
        server_default=text("'customer'"),
    )
    is_blocked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    __table_args__ = (
        CheckConstraint(
            "phone_verification_method IS NULL "
            "OR phone_verification_method IN ('telegram_contact', 'otp')",
            name="phone_verification_method_known",
        ),
        CheckConstraint(
            "(phone_verified_at IS NULL AND phone_verification_method IS NULL) "
            "OR (phone_verified_at IS NOT NULL AND phone_verification_method IS NOT NULL "
            "AND phone IS NOT NULL)",
            name="phone_verified_consistent",
        ),
    )
