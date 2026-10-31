"""Shared helpers for database-backed (``integration``) tests.

Each test module gets a fresh, uniquely named schema that is built with the REAL Alembic
migrations (never ``Base.metadata.create_all``) and dropped afterwards, so nothing else in the
database is touched and the migrations themselves are what the tests exercise.

The connection's ``search_path`` is ``"<schema>", public`` so the ``pg_trgm`` operator classes
(installed once into ``public``) resolve. Migrations are nevertheless pinned to the test schema
explicitly (version table, ``schema_translate_map``; see ``alembic/env.py``): relying on the
search_path alone, Alembic would find an already migrated ``public.alembic_version`` (for example
a developer database used as ``TEST_DATABASE_URL``) and skip the migrations, and the tests would
then run against, and truncate, the tables in ``public``.
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
SCHEMA_PREFIX = "mm_test_"


def database_url() -> str:
    return os.environ["TEST_DATABASE_URL"]


def owned_test_schema(connection: Connection) -> str:
    """The connection's own test schema (first on its search_path); never ``public``."""
    schema = connection.execute(text("SELECT current_schema()")).scalar_one()
    if not isinstance(schema, str) or not schema.startswith(SCHEMA_PREFIX):
        raise RuntimeError(f"refusing to migrate schema {schema!r}: not a test schema")
    return schema


def alembic_config(connection: Connection) -> Config:
    """Alembic config that runs on ``connection`` (see the hook in ``alembic/env.py``)."""
    config = Config()  # no ini file: keeps pytest's logging configuration intact
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    config.attributes["connection"] = connection
    config.attributes["schema"] = owned_test_schema(connection)
    return config


async def run_migration(engine: AsyncEngine, action: Callable[..., None], revision: str) -> None:
    """Run ``alembic upgrade|downgrade <revision>`` against the engine's own test schema."""

    def _run(connection: Connection) -> None:
        action(alembic_config(connection), revision)

    async with engine.connect() as connection:
        await connection.run_sync(_run)
        await connection.commit()


async def upgrade(engine: AsyncEngine, revision: str = "head") -> None:
    await run_migration(engine, command.upgrade, revision)


async def downgrade(engine: AsyncEngine, revision: str) -> None:
    await run_migration(engine, command.downgrade, revision)


async def create_schema(url: str, schema: str) -> None:
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            # Installed into ``public`` so it survives dropping any one test schema.
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public"))
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    finally:
        await admin.dispose()


async def drop_schema(url: str, schema: str) -> None:
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        await admin.dispose()


APP_TABLES = (
    "audit_log",
    "notification_outbox",
    "order_status_history",
    "order_items",
    "orders",
    "cart_items",
    "carts",
    "products",
    "categories",
    "delivery_zone_districts",
    "delivery_slots",
    "delivery_zones",
    "users",
)


async def engine_schema(engine: AsyncEngine) -> str:
    async with engine.connect() as conn:
        return await conn.run_sync(owned_test_schema)


# The migration's statement trigger that rejects ``TRUNCATE audit_log`` (append-only log).
AUDIT_TRUNCATE_TRIGGER = "audit_log_no_truncate"


async def truncate_app_tables(engine: AsyncEngine) -> None:
    """Empty the app tables of the engine's test schema, schema-qualified: never ``public``.

    ``audit_log`` refuses ``TRUNCATE``; its trigger is disabled for this one statement only, in
    the same transaction (DDL is transactional), so it is back on before anything else runs.
    """
    schema = await engine_schema(engine)
    tables = ", ".join(f'"{schema}"."{table}"' for table in APP_TABLES)
    audit_log = f'"{schema}"."audit_log"'
    async with engine.begin() as connection:
        await connection.execute(
            text(f"ALTER TABLE {audit_log} DISABLE TRIGGER {AUDIT_TRUNCATE_TRIGGER}")
        )
        await connection.execute(text(f"TRUNCATE {tables} CASCADE"))
        await connection.execute(
            text(f"ALTER TABLE {audit_log} ENABLE TRIGGER {AUDIT_TRUNCATE_TRIGGER}")
        )


async def _assert_migrated_into(engine: AsyncEngine, schema: str) -> None:
    """Fail loudly rather than let tests fall through to same-named tables in ``public``."""
    async with engine.connect() as conn:
        found = (
            await conn.execute(
                text("SELECT to_regclass(:users), to_regclass(:version)"),
                {"users": f'"{schema}".users', "version": f'"{schema}".alembic_version'},
            )
        ).one()
    if None in found:
        raise RuntimeError(f"migrations did not create their tables in {schema}")


async def schema_engine(*, migrate: bool) -> AsyncIterator[AsyncEngine]:
    url = database_url()
    schema = f"{SCHEMA_PREFIX}{uuid.uuid4().hex[:12]}"
    await create_schema(url, schema)
    engine = create_async_engine(
        url,
        pool_size=15,
        max_overflow=10,
        connect_args={"server_settings": {"search_path": f'"{schema}", public'}},
    )
    try:
        if migrate:
            await upgrade(engine)
            await _assert_migrated_into(engine, schema)
        yield engine
    finally:
        await engine.dispose()
        await drop_schema(url, schema)


# Integration modules share one migrated schema (and one event loop) per module; individual tests
# start from empty tables (see the ``session_factory`` fixture in ``tests/db_fixtures.py``).
INTEGRATION_MARKS = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]
