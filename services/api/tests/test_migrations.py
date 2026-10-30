"""Alembic migrations against a real PostgreSQL (skipped without TEST_DATABASE_URL)."""

import uuid
from datetime import UTC, datetime

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


CHECKOUT_TABLES = {
    "delivery_zones",
    "delivery_zone_districts",
    "order_status_history",
    "notification_outbox",
}


async def _columns(engine: AsyncEngine, table: str) -> set[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = :table"
            ),
            {"table": table},
        )
        return {row[0] for row in rows}


async def _constraints(engine: AsyncEngine, table: str) -> set[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT c.conname FROM pg_constraint c "
                "JOIN pg_class t ON t.oid = c.conrelid "
                "JOIN pg_namespace n ON n.oid = t.relnamespace "
                "WHERE n.nspname = current_schema() AND t.relname = :table"
            ),
            {"table": table},
        )
        return {row[0] for row in rows}


async def test_checkout_revision_downgrades_to_0002_and_back(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    after_upgrade = await _tables(empty_engine)
    assert after_upgrade >= CHECKOUT_TABLES
    order_columns = await _columns(empty_engine, "orders")
    assert {"delivery_zone_id", "item_count", "idempotency_request_hash"} <= order_columns
    assert "uq_orders_user_id_idempotency_key" in await _constraints(empty_engine, "orders")

    await downgrade(empty_engine, "0002")
    assert not (await _tables(empty_engine) & CHECKOUT_TABLES)
    assert not (
        {"delivery_zone_id", "item_count", "idempotency_request_hash"}
        & await _columns(empty_engine, "orders")
    )
    order_constraints = await _constraints(empty_engine, "orders")
    assert "uq_orders_idempotency_key" in order_constraints  # the 0002 global constraint is back
    assert not ({"uq_orders_user_id_idempotency_key", "ck_orders_total_is_sum"} & order_constraints)
    assert "ck_order_items_line_total_is_product" not in await _constraints(
        empty_engine, "order_items"
    )
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0002"

    await upgrade(empty_engine)
    assert await _tables(empty_engine) == after_upgrade
    assert await _columns(empty_engine, "orders") == order_columns
    assert await _model_differences(empty_engine) == []


async def test_models_match_after_each_revision_only_at_head(empty_engine: AsyncEngine) -> None:
    # Control for 0003: one revision behind still differs from the models.
    await upgrade(empty_engine, "0002")
    assert await _model_differences(empty_engine)
    await upgrade(empty_engine)
    assert await _model_differences(empty_engine) == []


_ORDER_SQL = text(
    "INSERT INTO orders (number, user_id, subtotal_uzs, delivery_fee_uzs, total_uzs, item_count, "
    "payment_method, recipient_name, recipient_phone, address_snapshot, idempotency_key, "
    "idempotency_request_hash) VALUES (:number, :user_id, :subtotal, :fee, :total, 1, "
    "'cash_on_delivery', 'Demo Mijoz', '+998001234567', '{}'::jsonb, :key, :hash) RETURNING id"
)


def _order_params(user_id: object, number: str, **overrides: object) -> dict[str, object]:
    params: dict[str, object] = {
        "number": number,
        "user_id": user_id,
        "subtotal": 50_000,
        "fee": 15_000,
        "total": 65_000,
        "key": f"key-{number}",
        "hash": "0" * 64,
    }
    params.update(overrides)
    return params


async def test_checkout_constraints(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    async with empty_engine.connect() as conn:
        user_id = (
            await conn.execute(
                text(
                    "INSERT INTO users (telegram_user_id, first_name) "
                    "VALUES (1001, 'Demo') RETURNING id"
                )
            )
        ).scalar_one()
        order_id = (await conn.execute(_ORDER_SQL, _order_params(user_id, "A-1"))).scalar_one()

        # total = subtotal + delivery fee
        with pytest.raises(IntegrityError, match="ck_orders_total_is_sum"):
            async with conn.begin_nested():
                await conn.execute(_ORDER_SQL, _order_params(user_id, "A-2", total=50_000))

        # The idempotency key is unique per user, not globally.
        with pytest.raises(IntegrityError, match="uq_orders_user_id_idempotency_key"):
            async with conn.begin_nested():
                await conn.execute(_ORDER_SQL, _order_params(user_id, "A-3", key="key-A-1"))
        other_user = (
            await conn.execute(
                text(
                    "INSERT INTO users (telegram_user_id, first_name) "
                    "VALUES (1002, 'Demo') RETURNING id"
                )
            )
        ).scalar_one()
        await conn.execute(_ORDER_SQL, _order_params(other_user, "B-1", key="key-A-1"))

        # line_total = unit_price * quantity
        item_sql = text(
            "INSERT INTO order_items (order_id, sku, name_uz, name_ru, unit, unit_price_uzs, "
            "quantity, line_total_uzs) VALUES (:order_id, 'DEMO-0001', 'Demo', 'Демо', 'piece', "
            ":price, :quantity, :line_total)"
        )
        await conn.execute(
            item_sql, {"order_id": order_id, "price": 25_000, "quantity": 2, "line_total": 50_000}
        )
        with pytest.raises(IntegrityError, match="ck_order_items_line_total_is_product"):
            async with conn.begin_nested():
                await conn.execute(
                    item_sql,
                    {"order_id": order_id, "price": 25_000, "quantity": 2, "line_total": 25_000},
                )

        # A district belongs to at most one zone (it is the primary key).
        zone_sql = text(
            "INSERT INTO delivery_zones (slug, name_uz, name_ru, delivery_fee_uzs, opens_at, "
            "closes_at) VALUES (:slug, 'Demo', 'Демо', 10000, '09:00', '21:00') RETURNING id"
        )
        zone_a = (await conn.execute(zone_sql, {"slug": "demo-a"})).scalar_one()
        zone_b = (await conn.execute(zone_sql, {"slug": "demo-b"})).scalar_one()
        district_sql = text(
            "INSERT INTO delivery_zone_districts (district, zone_id) VALUES (:district, :zone)"
        )
        await conn.execute(district_sql, {"district": "chilonzor", "zone": zone_a})
        with pytest.raises(IntegrityError, match="pk_delivery_zone_districts"):
            async with conn.begin_nested():
                await conn.execute(district_sql, {"district": "chilonzor", "zone": zone_b})
        with pytest.raises(IntegrityError, match="ck_delivery_zones_hours_ordered"):
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        "INSERT INTO delivery_zones (slug, name_uz, name_ru, delivery_fee_uzs, "
                        "opens_at, closes_at) VALUES ('demo-c', 'D', 'D', 0, '21:00', '09:00')"
                    )
                )

        # The outbox outcome is set if and only if the row is processed.
        outbox_sql = text(
            "INSERT INTO notification_outbox (event_type, order_id, payload, processed_at, "
            "outcome) VALUES ('order.status_changed', :order_id, '{}'::jsonb, :processed, "
            ":outcome)"
        )
        await conn.execute(outbox_sql, {"order_id": order_id, "processed": None, "outcome": None})
        await conn.execute(
            outbox_sql,
            {"order_id": order_id, "processed": datetime.now(UTC), "outcome": "delivered"},
        )
        for processed, outcome in ((datetime.now(UTC), None), (None, "delivered")):
            with pytest.raises(
                IntegrityError, match="ck_notification_outbox_outcome_iff_processed"
            ):
                async with conn.begin_nested():
                    await conn.execute(
                        outbox_sql,
                        {"order_id": order_id, "processed": processed, "outcome": outcome},
                    )


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
        assert await _scalar(my_engine, "SELECT version_num FROM alembic_version") == "0003"

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
