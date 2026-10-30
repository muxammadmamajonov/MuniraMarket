"""Alembic migrations against a real PostgreSQL (skipped without TEST_DATABASE_URL)."""

import uuid

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

import app.models  # noqa: F401  (registers every model on Base.metadata)
from app.db.base import Base
from tests.db_support import (
    SCHEMA_PREFIX,
    create_schema,
    database_url,
    downgrade,
    drop_schema,
    owned_test_schema,
    truncate_app_tables,
    upgrade,
)

pytest_plugins = ["tests.db_fixtures"]  # the empty_engine fixture
pytestmark = pytest.mark.integration

TRIGRAM_INDEXES = {
    "ix_products_name_uz_trgm": "name_uz",
    "ix_products_name_ru_trgm": "name_ru",
    "ix_products_sku_trgm": "sku",
}


async def _tables(engine: AsyncEngine) -> set[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = current_schema()"
            )
        )
        return {row[0] for row in rows}


async def test_upgrade_downgrade_upgrade(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    after_first_upgrade = await _tables(empty_engine)
    assert {"users", "categories", "products", "carts", "cart_items", "orders"} <= (
        after_first_upgrade
    )

    await downgrade(empty_engine, "0001")
    async with empty_engine.connect() as conn:
        columns = {
            row[0]
            for row in await conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = current_schema() "
                    "AND ((table_name = 'products' AND column_name = 'image_url') "
                    "OR (table_name = 'cart_items' AND column_name = 'created_at'))"
                )
            )
        }
        index_names = {
            row[0]
            for row in await conn.execute(
                text("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")
            )
        }
    assert columns == set()
    assert not (set(TRIGRAM_INDEXES) & index_names)

    await downgrade(empty_engine, "base")
    # Only Alembic's own bookkeeping table is left.
    assert await _tables(empty_engine) <= {"alembic_version"}

    await upgrade(empty_engine)
    assert await _tables(empty_engine) == after_first_upgrade


async def _model_differences(engine: AsyncEngine) -> list[object]:
    def diff(connection: Connection) -> list[object]:
        context = MigrationContext.configure(
            connection,
            opts={"compare_type": True, "compare_server_default": True},
        )
        # Reflection covers the connection's default schema only: the test schema, which is
        # first on its search_path (never ``public``).
        assert context.dialect.default_schema_name == owned_test_schema(connection)
        return list(compare_metadata(context, Base.metadata))

    async with engine.connect() as conn:
        return await conn.run_sync(diff)


async def test_models_match_migrated_schema(empty_engine: AsyncEngine) -> None:
    # Control: the comparison does notice a schema that is behind the models.
    await upgrade(empty_engine, "0001")
    assert await _model_differences(empty_engine)

    await upgrade(empty_engine)
    assert await _model_differences(empty_engine) == []


async def test_trigram_extension_and_indexes_exist(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    async with empty_engine.connect() as conn:
        extension = (
            await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"))
        ).scalar_one_or_none()
        definitions = {
            row.indexname: row.indexdef
            for row in await conn.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE schemaname = current_schema() AND tablename = 'products'"
                )
            )
        }
    assert extension == 1
    for name, column in TRIGRAM_INDEXES.items():
        assert name in definitions
        assert "USING gin" in definitions[name]
        assert f"{column} gin_trgm_ops" in definitions[name].replace("public.", "")


async def test_stock_quantity_cannot_be_negative(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    async with empty_engine.connect() as conn:
        category_id = (
            await conn.execute(
                text(
                    "INSERT INTO categories (slug, name_uz, name_ru) "
                    "VALUES ('c', 'C', 'C') RETURNING id"
                )
            )
        ).scalar_one()
        insert = text(
            "INSERT INTO products (category_id, sku, slug, name_uz, name_ru, unit, price_uzs, "
            "stock_quantity) VALUES (:cat, :sku, :sku, 'P', 'P', 'piece', 1000, :stock)"
        )
        # Zero and "not tracked" (NULL) are valid.
        await conn.execute(insert, {"cat": category_id, "sku": "ok-zero", "stock": 0})
        await conn.execute(insert, {"cat": category_id, "sku": "ok-null", "stock": None})
        with pytest.raises(IntegrityError, match="ck_products_stock_non_negative"):
            await conn.execute(insert, {"cat": category_id, "sku": "bad", "stock": -1})


async def _scalar(engine: AsyncEngine, sql: str, **params: object) -> object:
    async with engine.connect() as conn:
        return (await conn.execute(text(sql), params)).scalar_one()


async def test_an_already_migrated_schema_on_the_search_path_is_never_touched() -> None:
    """Regression: with a migrated schema later on the search_path (like a developer's migrated
    and seeded ``public``), Alembic used to find that schema's version table, skip the test
    schema's migrations, and the fixtures then truncated the other schema's tables.

    A second schema stands in for ``public`` so the test does not depend on its state.
    """
    url = database_url()
    other = f"{SCHEMA_PREFIX}other_{uuid.uuid4().hex[:8]}"
    mine = f"{SCHEMA_PREFIX}{uuid.uuid4().hex[:12]}"
    await create_schema(url, other)
    await create_schema(url, mine)

    def engine_on(search_path: str) -> AsyncEngine:
        return create_async_engine(
            url, connect_args={"server_settings": {"search_path": search_path}}
        )

    other_engine = engine_on(f'"{other}", public')
    my_engine = engine_on(f'"{mine}", "{other}", public')
    count_other = f'SELECT count(*) FROM "{other}".categories'  # noqa: S608 - generated name
    tables_in = (
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema = :schema AND table_name IN ('users', 'alembic_version')"
    )
    try:
        await upgrade(other_engine)
        async with other_engine.begin() as conn:
            await conn.execute(
                text("INSERT INTO categories (slug, name_uz, name_ru) VALUES ('k', 'K', 'K')")
            )

        await upgrade(my_engine)
        assert await _scalar(my_engine, tables_in, schema=mine) == 2
        assert await _scalar(my_engine, "SELECT version_num FROM alembic_version") == "0002"

        await truncate_app_tables(my_engine)
        assert await _scalar(my_engine, count_other) == 1

        await downgrade(my_engine, "base")
        assert await _scalar(my_engine, tables_in, schema=mine) == 1  # only alembic_version
        assert await _scalar(my_engine, tables_in, schema=other) == 2
        assert await _scalar(my_engine, count_other) == 1
    finally:
        await my_engine.dispose()
        await other_engine.dispose()
        await drop_schema(url, mine)
        await drop_schema(url, other)


def test_helpers_refuse_a_non_test_schema() -> None:
    class _Conn:
        def execute(self, _: object) -> "_Conn":
            return self

        def scalar_one(self) -> str:
            return "public"

    with pytest.raises(RuntimeError, match="not a test schema"):
        owned_test_schema(_Conn())  # type: ignore[arg-type]
