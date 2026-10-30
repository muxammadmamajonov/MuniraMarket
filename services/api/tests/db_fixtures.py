"""Fixtures for database-backed tests; load with ``pytest_plugins = ["tests.db_fixtures"]``."""

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from tests.db_support import schema_engine, truncate_app_tables


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def engine() -> AsyncIterator[AsyncEngine]:
    """A per-module schema migrated to ``head`` with the real Alembic migrations."""
    async for test_engine in schema_engine(migrate=True):
        yield test_engine


@pytest_asyncio.fixture
async def empty_engine() -> AsyncIterator[AsyncEngine]:
    """A fresh empty schema (no migrations applied), for tests that run migrations themselves."""
    async for test_engine in schema_engine(migrate=False):
        yield test_engine


@pytest_asyncio.fixture(loop_scope="module")
async def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Sessions on the migrated schema; every test starts with empty tables (schema-qualified
    TRUNCATE, so ``public`` is never touched)."""
    await truncate_app_tables(engine)
    return async_sessionmaker(engine, expire_on_commit=False)
