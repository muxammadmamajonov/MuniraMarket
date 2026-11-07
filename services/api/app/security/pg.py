"""Shared plumbing for the PostgreSQL-backed security stores (ADR 0013).

Every store operation runs in its own short transaction on the application's pool, separate from
the request's own database session, so a route that later rolls back never undoes a rate-limit
hit, a recorded nonce or a session rotation. Any database failure becomes
:class:`StoreUnavailableError`, which callers turn into ``503`` (fail closed).
"""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.security.errors import StoreUnavailableError

SessionFactory = async_sessionmaker[AsyncSession]


def as_datetime(epoch_seconds: float) -> datetime:
    """The injectable clock's Unix time as an aware UTC datetime (``timestamptz`` columns)."""
    return datetime.fromtimestamp(epoch_seconds, UTC)


async def in_transaction[T](
    factory: SessionFactory, work: Callable[[AsyncSession], Awaitable[T]]
) -> T:
    """Run ``work`` in one committed transaction; database failures fail closed."""
    try:
        async with factory() as session, session.begin():
            return await work(session)
    except (SQLAlchemyError, OSError, TimeoutError):
        raise StoreUnavailableError from None
