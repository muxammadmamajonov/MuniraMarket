"""Short-lived security state kept in PostgreSQL (ADR 0013).

These tables replace the former Redis keyspace. Every row carries ``expires_at``; readers always
filter on it, so correctness never depends on the cleanup job, which only reclaims space
(``app/repositories/security_state.py``). No row holds a usable secret: sessions and OIDC states
are keyed by ``sha256`` of the browser-held token, never by the token itself.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AuthSession(Base):
    """Browser session or rotation tombstone, keyed by ``sha256(token)`` hex (ADR 0007)."""

    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    # ``{"user_id", "telegram_user_id", "csrf_token", ...}`` or ``{"rotated_to": "<hash>"}``.
    record: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Set for live records only, so every session of a user can be found (and revoked).
    # No foreign key: a session row is short-lived security state, not business data, and
    # revocation goes through the user id (``revoke_user``) whatever happened to the user row.
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint("token_hash ~ '^[0-9a-f]{64}$'", name="token_hash_hex"),
        Index("ix_auth_sessions_expires_at", "expires_at"),
        Index("ix_auth_sessions_user_id", "user_id"),
    )


class RateLimitCounter(Base):
    """One fixed-window counter: ``<scope>:<subject>:<window_start>``."""

    __tablename__ = "rate_limit_counters"

    bucket: Mapped[str] = mapped_column(String(200), primary_key=True)
    hits: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint("hits > 0", name="hits_positive"),
        Index("ix_rate_limit_counters_expires_at", "expires_at"),
    )


class ServiceRequestNonce(Base):
    """A service-request nonce seen within its replay window (ADR 0003)."""

    __tablename__ = "service_request_nonces"

    key_id: Mapped[str] = mapped_column(String(32), nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("key_id", "nonce", name="pk_service_request_nonces"),
        Index("ix_service_request_nonces_expires_at", "expires_at"),
    )


class OidcLoginState(Base):
    """A started Telegram OIDC login, consumed exactly once by the callback (ADR 0014).

    Keyed by ``sha256(state)``; ``binding_hash`` is ``sha256`` of the random value in the
    browser's short-lived binding cookie, so a callback URL replayed in another browser fails.
    """

    __tablename__ = "oidc_login_states"

    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    binding_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entrance: Mapped[str] = mapped_column(String(16), nullable=False)
    code_verifier: Mapped[str] = mapped_column(String(128), nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    return_to: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint("entrance IN ('storefront', 'admin')", name="entrance_known"),
        Index("ix_oidc_login_states_expires_at", "expires_at"),
    )
