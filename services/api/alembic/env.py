"""Async Alembic environment. The URL comes from the environment, never from alembic.ini.

``MIGRATION_DATABASE_URL`` (the migration role) when set, else the application's DATABASE_URL.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

import app.models  # noqa: F401  (registers every model on Base.metadata)
from app.db.base import Base
from app.db.migration_url import migration_database_url

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    return migration_database_url()


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _not_version_table(
    _obj: object, name: str | None, type_: str, _reflected: bool, _compare_to: object
) -> bool:
    return not (type_ == "table" and name == "alembic_version")


def _do_run_migrations(connection: Connection, schema: str | None = None) -> None:
    if schema is None:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    else:
        # Pin everything to ``schema`` instead of relying on search_path visibility: the version
        # table, every unqualified table/index/enum (schema_translate_map also makes the enums'
        # ``checkfirst`` look in ``schema`` only), and autogenerate comparisons. Otherwise a
        # migrated ``public`` later on the search_path is mistaken for this schema's state.
        connection.execution_options(schema_translate_map={None: schema})
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            version_table_schema=schema,
            include_schemas=False,
            # The version table now has an explicit schema, so autogenerate would no longer
            # recognise it as Alembic's own when comparing the (default) schema.
            include_object=_not_version_table,
        )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()
    connectable = async_engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


# Programmatic use (integration tests): the caller hands over an open synchronous connection via
# ``config.attributes["connection"]`` (inside ``AsyncConnection.run_sync``) and the schema to
# migrate via ``config.attributes["schema"]``, so a test owns its schema completely, whatever
# else exists in the database. Without them the behaviour is unchanged.
_external_connection: Connection | None = config.attributes.get("connection")

if _external_connection is not None:
    _do_run_migrations(_external_connection, config.attributes.get("schema"))
elif context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
