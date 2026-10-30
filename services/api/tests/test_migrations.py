"""Alembic migrations against a real PostgreSQL (skipped without TEST_DATABASE_URL)."""

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

import app.models  # noqa: F401  (registers every model on Base.metadata)
from app.db.base import Base
from tests.db_support import downgrade, upgrade

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
            connection, opts={"compare_type": True, "compare_server_default": True}
        )
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
