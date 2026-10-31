"""Async engine and session factory construction (no connection is opened here)."""

from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings

APPLICATION_NAME = "muniramarket-core-api"


def connect_args(settings: Settings) -> dict[str, Any]:
    """asyncpg connect arguments: connect timeout and per-session server guards.

    ``application_name`` makes the API's connections recognisable in ``pg_stat_activity`` (and
    Neon's monitoring), separate from the one-off migration job. TLS itself is configured in
    ``DATABASE_URL`` (``?ssl=verify-full`` outside development, enforced by settings).
    """
    server_settings = {"application_name": APPLICATION_NAME}
    if settings.db_statement_timeout_ms:
        server_settings["statement_timeout"] = str(settings.db_statement_timeout_ms)
    if settings.db_idle_in_transaction_timeout_ms:
        server_settings["idle_in_transaction_session_timeout"] = str(
            settings.db_idle_in_transaction_timeout_ms
        )
    return {"timeout": settings.db_connect_timeout_seconds, "server_settings": server_settings}


def create_engine(settings: Settings) -> AsyncEngine:
    return create_async_engine(
        settings.database_url.get_secret_value(),
        pool_pre_ping=True,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout_seconds,
        # Below typical idle cut-offs of managed Postgres/poolers, so a recycled connection is
        # never one the server already dropped.
        pool_recycle=1800,
        connect_args=connect_args(settings),
        # Bound parameters (addresses, phone numbers) never appear in exception text or logs.
        hide_parameters=True,
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
