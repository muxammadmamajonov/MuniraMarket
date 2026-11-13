"""Alembic migrations against a real PostgreSQL (skipped without TEST_DATABASE_URL)."""

import uuid
from datetime import UTC, date, datetime, time

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError, IntegrityError
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
    # The zone tables and columns of 0003 exist until 0007 drops them.
    await upgrade(empty_engine, "0006")
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

    await upgrade(empty_engine, "0006")
    assert await _tables(empty_engine) == after_upgrade
    assert await _columns(empty_engine, "orders") == order_columns
    await upgrade(empty_engine)
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
    # As of 0006 (the delivery fee, zone and district constraints are dropped by 0007).
    await upgrade(empty_engine, "0006")
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
        assert await _scalar(my_engine, "SELECT version_num FROM alembic_version") == "0008"

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


# --- 0004: admin content operations ---------------------------------------------------------------

ADMIN_TABLES = {"delivery_slots", "audit_log"}
SLOT_ORDER_COLUMNS = {
    "delivery_slot_id",
    "delivery_slot_date",
    "delivery_slot_starts_at",
    "delivery_slot_ends_at",
}
_FUNCTION_SQL = (
    "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
    "WHERE n.nspname = current_schema() AND p.proname = 'audit_log_reject_change'"
)
_AUDIT_TRIGGERS_SQL = (
    "SELECT t.tgname::text, t.tgenabled::text FROM pg_trigger t "
    "JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE n.nspname = current_schema() AND NOT t.tgisinternal "
    "AND t.tgname IN ('audit_log_append_only', 'audit_log_no_truncate') ORDER BY t.tgname"
)


async def _audit_triggers(engine: AsyncEngine) -> list[tuple[str, str]]:
    """``(name, tgenabled)`` of the audit_log triggers; ``O`` means enabled."""
    async with engine.connect() as conn:
        return [(row[0], row[1]) for row in await conn.execute(text(_AUDIT_TRIGGERS_SQL))]


async def test_admin_revision_downgrades_to_0003_and_back(empty_engine: AsyncEngine) -> None:
    # The slot table and columns of 0004 exist until 0007 drops them.
    await upgrade(empty_engine, "0006")
    after_upgrade = await _tables(empty_engine)
    assert after_upgrade >= ADMIN_TABLES
    assert await _columns(empty_engine, "orders") >= SLOT_ORDER_COLUMNS
    assert {"sort_order", "archived_at"} <= await _columns(empty_engine, "products")
    assert await _scalar(empty_engine, _FUNCTION_SQL) == 1
    assert await _audit_triggers(empty_engine) == [
        ("audit_log_append_only", "O"),
        ("audit_log_no_truncate", "O"),
    ]

    await downgrade(empty_engine, "0003")
    assert not (await _tables(empty_engine) & ADMIN_TABLES)
    assert not (SLOT_ORDER_COLUMNS & await _columns(empty_engine, "orders"))
    assert not ({"sort_order", "archived_at"} & await _columns(empty_engine, "products"))
    assert "ck_products_archived_is_inactive" not in await _constraints(empty_engine, "products")
    assert await _scalar(empty_engine, _FUNCTION_SQL) == 0
    assert await _audit_triggers(empty_engine) == []
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0003"

    await upgrade(empty_engine, "0006")
    assert await _tables(empty_engine) == after_upgrade
    await upgrade(empty_engine)
    assert await _model_differences(empty_engine) == []


SECURITY_STATE_TABLES = {
    "auth_sessions",
    "rate_limit_counters",
    "service_request_nonces",
    "oidc_login_states",
    "staff_notification_chat",
}


async def test_security_state_revision_downgrades_to_0004_and_back(
    empty_engine: AsyncEngine,
) -> None:
    await upgrade(empty_engine)
    after_upgrade = await _tables(empty_engine)
    assert after_upgrade >= SECURITY_STATE_TABLES
    for table in SECURITY_STATE_TABLES - {"staff_notification_chat"}:
        assert "expires_at" in await _columns(empty_engine, table)
    assert "ck_staff_notification_chat_single_row" in await _constraints(
        empty_engine, "staff_notification_chat"
    )

    await downgrade(empty_engine, "0004")
    assert not (await _tables(empty_engine) & SECURITY_STATE_TABLES)
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0004"

    await upgrade(empty_engine)
    assert await _tables(empty_engine) == after_upgrade
    assert await _model_differences(empty_engine) == []


async def test_audit_log_is_append_only(empty_engine: AsyncEngine) -> None:
    await upgrade(empty_engine)
    async with empty_engine.connect() as conn:
        audit_id = (
            await conn.execute(
                text(
                    "INSERT INTO audit_log (actor_role, action, entity_type, entity_id, details) "
                    "VALUES ('admin', 'zone.create', 'zone', 'z-1', '{}'::jsonb) RETURNING id"
                )
            )
        ).scalar_one()
        for statement in (
            "UPDATE audit_log SET action = 'zone.delete' WHERE id = :id",
            "DELETE FROM audit_log WHERE id = :id",
            "TRUNCATE audit_log",
            "TRUNCATE audit_log CASCADE",
        ):
            with pytest.raises(DBAPIError, match="audit_log is append-only"):
                async with conn.begin_nested():
                    await conn.execute(text(statement), {"id": audit_id})
        assert (
            await conn.execute(
                text("SELECT action FROM audit_log WHERE id = :id"), {"id": audit_id}
            )
        ).scalar_one() == "zone.create"
        await conn.commit()

    # The test harness empties the tables between tests: it may truncate the log, and leaves the
    # trigger enabled again afterwards.
    await truncate_app_tables(empty_engine)
    assert await _scalar(empty_engine, "SELECT count(*) FROM audit_log") == 0
    assert ("audit_log_no_truncate", "O") in await _audit_triggers(empty_engine)


async def test_admin_check_constraints(empty_engine: AsyncEngine) -> None:
    # As of 0006 (delivery slots are dropped by 0007).
    await upgrade(empty_engine, "0006")
    async with empty_engine.connect() as conn:
        zone_id = (
            await conn.execute(
                text(
                    "INSERT INTO delivery_zones (slug, name_uz, name_ru, delivery_fee_uzs, "
                    "opens_at, closes_at) VALUES ('demo-z', 'D', 'Д', 0, '09:00', '21:00') "
                    "RETURNING id"
                )
            )
        ).scalar_one()
        slot_sql = text(
            "INSERT INTO delivery_slots (zone_id, slot_date, starts_at, ends_at, capacity, "
            "reserved_count, cutoff_at) VALUES (:zone, :day, :starts, '13:00', :capacity, "
            ":reserved, '2026-11-02T03:00:00Z') RETURNING id"
        )

        def slot(starts: str, capacity: int, reserved: int) -> dict[str, object]:
            return {
                "zone": zone_id,
                "day": date(2026, 11, 2),
                "starts": time.fromisoformat(starts),
                "capacity": capacity,
                "reserved": reserved,
            }

        slot_id = (await conn.execute(slot_sql, slot("10:00", 2, 2))).scalar_one()  # full is fine
        with pytest.raises(IntegrityError, match="ck_delivery_slots_reserved_within_capacity"):
            async with conn.begin_nested():
                await conn.execute(slot_sql, slot("11:00", 2, 3))
        with pytest.raises(IntegrityError, match="ck_delivery_slots_reserved_within_capacity"):
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        "UPDATE delivery_slots SET reserved_count = reserved_count + 1 "
                        "WHERE id = :id"
                    ),
                    {"id": slot_id},
                )
        with pytest.raises(IntegrityError, match="ck_delivery_slots_reserved_non_negative"):
            async with conn.begin_nested():
                await conn.execute(slot_sql, slot("11:00", 2, -1))
        with pytest.raises(IntegrityError, match="uq_delivery_slots_zone_id_slot_date_starts_at"):
            async with conn.begin_nested():
                await conn.execute(slot_sql, slot("10:00", 5, 0))

        category_id = (
            await conn.execute(
                text(
                    "INSERT INTO categories (slug, name_uz, name_ru) "
                    "VALUES ('c', 'C', 'C') RETURNING id"
                )
            )
        ).scalar_one()
        product_sql = text(
            "INSERT INTO products (category_id, sku, slug, name_uz, name_ru, unit, price_uzs, "
            "is_active, archived_at) VALUES (:cat, :sku, :sku, 'P', 'P', 'piece', 1000, "
            ":active, :archived)"
        )
        archived = datetime(2026, 10, 31, tzinfo=UTC)
        await conn.execute(
            product_sql, {"cat": category_id, "sku": "ok", "active": False, "archived": archived}
        )
        with pytest.raises(IntegrityError, match="ck_products_archived_is_inactive"):
            async with conn.begin_nested():
                await conn.execute(
                    product_sql,
                    {"cat": category_id, "sku": "bad", "active": True, "archived": archived},
                )


# --- 0007: Yandex Go courier delivery (no zones, fees or slots) -----------------------------------

DELIVERY_TABLES = {"delivery_zones", "delivery_zone_districts", "delivery_slots"}
DELIVERY_ORDER_COLUMNS = {
    "delivery_fee_uzs",
    "delivery_zone_id",
    "delivery_slot_id",
    "delivery_slot_date",
    "delivery_slot_starts_at",
    "delivery_slot_ends_at",
}
_ORDER_0007_SQL = text(
    "INSERT INTO orders (number, user_id, subtotal_uzs, total_uzs, item_count, payment_method, "
    "recipient_name, recipient_phone, address_snapshot, idempotency_key, "
    "idempotency_request_hash) VALUES (:number, :user_id, :subtotal, :total, 1, "
    "'cash_on_delivery', 'Demo Mijoz', '+998001234567', "
    '\'{"lat": 41.311081, "lon": 69.240562, "street": "Demo", "house": "1"}\'::jsonb, '
    ":key, :hash) RETURNING id"
)


async def _order_totals(engine: AsyncEngine) -> dict[str, tuple[int, int]]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT number, subtotal_uzs, total_uzs FROM orders"))
        return {row.number: (row.subtotal_uzs, row.total_uzs) for row in rows}


async def _indexes(engine: AsyncEngine, table: str) -> set[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT indexname FROM pg_indexes "
                "WHERE schemaname = current_schema() AND tablename = :table"
            ),
            {"table": table},
        )
        return {row[0] for row in rows}


async def test_courier_delivery_revision_keeps_historical_totals_and_downgrades(
    empty_engine: AsyncEngine,
) -> None:
    """0007 drops zones, slots and the delivery fee column without touching any order total;
    the downgrade gives the fee back as ``total - subtotal``."""
    await upgrade(empty_engine, "0006")
    async with empty_engine.begin() as conn:
        user_id = (
            await conn.execute(
                text(
                    "INSERT INTO users (telegram_user_id, first_name) "
                    "VALUES (2001, 'Demo') RETURNING id"
                )
            )
        ).scalar_one()
        zone_id = (
            await conn.execute(
                text(
                    "INSERT INTO delivery_zones (slug, name_uz, name_ru, delivery_fee_uzs, "
                    "opens_at, closes_at) VALUES ('demo-z', 'D', 'Д', 15000, '09:00', '21:00') "
                    "RETURNING id"
                )
            )
        ).scalar_one()
        await conn.execute(
            text("INSERT INTO delivery_zone_districts (district, zone_id) VALUES ('c', :zone)"),
            {"zone": zone_id},
        )
        slot_id = (
            await conn.execute(
                text(
                    "INSERT INTO delivery_slots (zone_id, slot_date, starts_at, ends_at, "
                    "capacity, reserved_count, cutoff_at) VALUES (:zone, '2026-11-02', "
                    "'10:00', '13:00', 5, 1, '2026-11-02T03:00:00Z') RETURNING id"
                ),
                {"zone": zone_id},
            )
        ).scalar_one()
        # A historical order that paid a 15 000 fee, booked in a slot of the zone ...
        paid = (await conn.execute(_ORDER_SQL, _order_params(user_id, "H-1"))).scalar_one()
        await conn.execute(
            text(
                "UPDATE orders SET delivery_zone_id = :zone, delivery_slot_id = :slot, "
                "delivery_slot_date = '2026-11-02', delivery_slot_starts_at = '10:00', "
                "delivery_slot_ends_at = '13:00' WHERE id = :id"
            ),
            {"zone": zone_id, "slot": slot_id, "id": paid},
        )
        # ... and one that had free delivery.
        await conn.execute(
            _ORDER_SQL, _order_params(user_id, "H-2", subtotal=400_000, fee=0, total=400_000)
        )

    await upgrade(empty_engine, "0007")
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0007"
    assert not (await _tables(empty_engine) & DELIVERY_TABLES)
    assert not (DELIVERY_ORDER_COLUMNS & await _columns(empty_engine, "orders"))
    assert "ix_orders_delivery_slot_id" not in await _indexes(empty_engine, "orders")
    # Historical totals still include the fee that was charged.
    assert await _order_totals(empty_engine) == {
        "H-1": (50_000, 65_000),
        "H-2": (400_000, 400_000),
    }
    order_constraints = await _constraints(empty_engine, "orders")
    assert "ck_orders_total_covers_subtotal" in order_constraints
    assert not (
        {"ck_orders_total_is_sum", "ck_orders_delivery_fee_non_negative"} & order_constraints
    )
    # The address snapshot is untouched (no rewrite of JSONB).
    assert (
        await _scalar(empty_engine, "SELECT address_snapshot FROM orders WHERE number = 'H-1'")
        == {}
    )

    async with empty_engine.connect() as conn:
        params = {"user_id": user_id, "key": "key-N-1", "hash": "0" * 64}
        # A courier-era order: total == subtotal.
        await conn.execute(
            _ORDER_0007_SQL, {**params, "number": "N-1", "subtotal": 30_000, "total": 30_000}
        )
        with pytest.raises(IntegrityError, match="ck_orders_total_covers_subtotal"):
            async with conn.begin_nested():
                await conn.execute(
                    _ORDER_0007_SQL,
                    {
                        **params,
                        "number": "N-2",
                        "key": "key-N-2",
                        "subtotal": 30_000,
                        "total": 29_999,
                    },
                )
        await conn.commit()

    await downgrade(empty_engine, "0006")
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0006"
    assert await _tables(empty_engine) >= DELIVERY_TABLES
    assert await _columns(empty_engine, "orders") >= DELIVERY_ORDER_COLUMNS
    assert "ix_orders_delivery_slot_id" in await _indexes(empty_engine, "orders")
    for table in DELIVERY_TABLES:
        assert await _scalar(empty_engine, f"SELECT count(*) FROM {table}") == 0  # noqa: S608
    async with empty_engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT number, subtotal_uzs, delivery_fee_uzs, total_uzs, delivery_zone_id, "
                    "delivery_slot_id, delivery_slot_date FROM orders ORDER BY number"
                )
            )
        ).all()
    # The fee is back as total - subtotal; zone and slot links are gone for good.
    assert [tuple(row) for row in rows] == [
        ("H-1", 50_000, 15_000, 65_000, None, None, None),
        ("H-2", 400_000, 0, 400_000, None, None, None),
        ("N-1", 30_000, 0, 30_000, None, None, None),
    ]
    order_constraints = await _constraints(empty_engine, "orders")
    assert {"ck_orders_total_is_sum", "ck_orders_delivery_fee_non_negative"} <= order_constraints
    assert "ck_orders_total_covers_subtotal" not in order_constraints
    assert {
        "fk_orders_delivery_zone_id_delivery_zones",
        "fk_orders_delivery_slot_id_delivery_slots",
    } <= order_constraints
    async with empty_engine.connect() as conn:
        with pytest.raises(IntegrityError, match="ck_orders_total_is_sum"):
            await conn.execute(_ORDER_SQL, _order_params(user_id, "D-1", total=1))

    await upgrade(empty_engine)
    assert await _order_totals(empty_engine) == {
        "H-1": (50_000, 65_000),
        "H-2": (400_000, 400_000),
        "N-1": (30_000, 30_000),
    }
    assert await _model_differences(empty_engine) == []


# --- 0008: profile hub (birth date, user-edited name, saved addresses) ----------------------------

_ADDRESS_SQL = text(
    "INSERT INTO user_addresses (user_id, label, lat, lon, street, house, is_default) "
    "VALUES (:user_id, :label, :lat, :lon, 'Amir Temur', '1', :is_default) RETURNING id"
)


async def test_profile_revision_adds_addresses_and_downgrades(empty_engine: AsyncEngine) -> None:
    """0008 adds two nullable user columns and ``user_addresses`` (cascade on user delete, at
    most one default per user, coordinate ranges); the downgrade drops them, users stay."""
    await upgrade(empty_engine, "0007")
    async with empty_engine.begin() as conn:
        user_id = (
            await conn.execute(
                text(
                    "INSERT INTO users (telegram_user_id, first_name, last_name) "
                    "VALUES (3001, 'Aziza', 'K') RETURNING id"
                )
            )
        ).scalar_one()
    assert "user_addresses" not in await _tables(empty_engine)

    await upgrade(empty_engine, "0008")
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0008"
    assert {"birth_date", "name_edited_at"} <= await _columns(empty_engine, "users")
    assert (
        await _scalar(
            empty_engine,
            "SELECT birth_date IS NULL AND name_edited_at IS NULL FROM users WHERE id = :id",
            id=user_id,
        )
        is True
    )
    assert await _indexes(empty_engine, "user_addresses") >= {
        "pk_user_addresses",
        "ix_user_addresses_user_id",
        "uq_user_addresses_user_id_default",
    }
    assert await _constraints(empty_engine, "user_addresses") >= {
        "ck_user_addresses_lat_range",
        "ck_user_addresses_lon_range",
        "fk_user_addresses_user_id_users",
    }
    assert await _model_differences(empty_engine) == []

    base = {"user_id": user_id, "label": None, "lat": 41.311081, "lon": 69.240562}
    async with empty_engine.connect() as conn:
        await conn.execute(_ADDRESS_SQL, {**base, "label": "Uy", "is_default": True})
        await conn.execute(_ADDRESS_SQL, {**base, "is_default": False})
        await conn.execute(_ADDRESS_SQL, {**base, "is_default": False})
        with pytest.raises(IntegrityError, match="uq_user_addresses_user_id_default"):
            async with conn.begin_nested():
                await conn.execute(_ADDRESS_SQL, {**base, "is_default": True})
        for bad, constraint in (
            ({"lat": 90.000001}, "ck_user_addresses_lat_range"),
            ({"lon": -180.5}, "ck_user_addresses_lon_range"),
        ):
            with pytest.raises(IntegrityError, match=constraint):
                async with conn.begin_nested():
                    await conn.execute(_ADDRESS_SQL, {**base, **bad, "is_default": False})
        await conn.commit()
    assert await _scalar(empty_engine, "SELECT count(*) FROM user_addresses") == 3

    # Deleting the user deletes their addresses.
    async with empty_engine.begin() as conn:
        other = (
            await conn.execute(
                text(
                    "INSERT INTO users (telegram_user_id, first_name) "
                    "VALUES (3002, 'Other') RETURNING id"
                )
            )
        ).scalar_one()
        await conn.execute(_ADDRESS_SQL, {**base, "user_id": other, "is_default": True})
        await conn.execute(text("DELETE FROM users WHERE id = :id"), {"id": other})
    assert await _scalar(empty_engine, "SELECT count(*) FROM user_addresses") == 3

    async with empty_engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE users SET birth_date = '1990-05-17', name_edited_at = now() WHERE id = :id"
            ),
            {"id": user_id},
        )

    await downgrade(empty_engine, "0007")
    assert await _scalar(empty_engine, "SELECT version_num FROM alembic_version") == "0007"
    assert "user_addresses" not in await _tables(empty_engine)
    assert not ({"birth_date", "name_edited_at"} & await _columns(empty_engine, "users"))
    assert (
        await _scalar(empty_engine, "SELECT first_name FROM users WHERE id = :id", id=user_id)
        == "Aziza"
    )

    await upgrade(empty_engine)
    assert await _scalar(empty_engine, "SELECT count(*) FROM user_addresses") == 0
    assert await _model_differences(empty_engine) == []
