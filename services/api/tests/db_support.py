"""Shared helpers for database-backed (``integration``) tests.

Each test module gets a fresh, uniquely named schema that is built with the REAL Alembic
migrations (never ``Base.metadata.create_all``) and dropped afterwards, so nothing else in the
database is touched and the migrations themselves are what the tests exercise.

The connection's ``search_path`` is ``"<schema>", public``: tables, types and the alembic version
table land in the test schema, while the ``pg_trgm`` operator classes (installed once into
``public``) still resolve.
"""

import os
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

API_ROOT = Path(__file__).resolve().parent.parent


def database_url() -> str:
    return os.environ["TEST_DATABASE_URL"]


def alembic_config(connection: Connection) -> Config:
    """Alembic config that runs on ``connection`` (see the hook in ``alembic/env.py``)."""
    config = Config()  # no ini file: keeps pytest's logging configuration intact
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    config.attributes["connection"] = connection
    return config


async def run_migration(engine: AsyncEngine, action: Callable[..., None], revision: str) -> None:
    """Run ``alembic upgrade|downgrade <revision>`` against the engine's schema."""

    def _run(connection: Connection) -> None:
        action(alembic_config(connection), revision)

    async with engine.connect() as connection:
        await connection.run_sync(_run)
        await connection.commit()


async def upgrade(engine: AsyncEngine, revision: str = "head") -> None:
    await run_migration(engine, command.upgrade, revision)


async def downgrade(engine: AsyncEngine, revision: str) -> None:
    await run_migration(engine, command.downgrade, revision)


async def _create_schema(url: str, schema: str) -> None:
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            # Installed into ``public`` so it survives dropping any one test schema.
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public"))
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    finally:
        await admin.dispose()


async def _drop_schema(url: str, schema: str) -> None:
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        await admin.dispose()


async def schema_engine(*, migrate: bool) -> AsyncIterator[AsyncEngine]:
    url = database_url()
    schema = f"mm_test_{uuid.uuid4().hex[:12]}"
    await _create_schema(url, schema)
    engine = create_async_engine(
        url,
        pool_size=15,
        max_overflow=10,
        connect_args={"server_settings": {"search_path": f'"{schema}", public'}},
    )
    try:
        if migrate:
            await upgrade(engine)
        yield engine
    finally:
        await engine.dispose()
        await _drop_schema(url, schema)


# Integration modules share one migrated schema (and one event loop) per module; individual tests
# start from empty tables (see the ``session_factory`` fixture in ``tests/db_fixtures.py``).
INTEGRATION_MARKS = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]
