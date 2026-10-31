"""Database-backed tests. Skipped unless TEST_DATABASE_URL points at a disposable PostgreSQL.

The schema is built by the real Alembic migrations in a per-module schema that is dropped
afterwards (see ``tests/db_support.py``), so nothing else in the database is touched.
"""

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.domain.order_status import OrderStatus
from app.models.catalog import Category, Product
from app.models.enums import Language, PaymentMethod, Unit
from app.models.order import Order
from app.repositories.users import SqlAlchemyUserRepository, TelegramProfile
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS


async def test_upsert_creates_then_updates(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        created = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(42, "Aziza", "K", "aziza", "ru")
        )
    assert created.language is Language.RU
    assert created.role.value == "customer"
    assert not created.is_blocked

    async with session_factory() as session:
        updated = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(42, "Aziza2", None, None, "uz")
        )
        fetched = await SqlAlchemyUserRepository(session).get_by_telegram_id(42)
    assert updated.id == created.id
    assert updated.first_name == "Aziza2"
    assert updated.username is None
    assert updated.language is Language.RU  # language is only seeded on first sign-in
    assert fetched == updated

    async with session_factory() as session:
        assert await SqlAlchemyUserRepository(session).get_by_telegram_id(43) is None
        assert await SqlAlchemyUserRepository(session).get_by_id(created.id) == updated
        assert await SqlAlchemyUserRepository(session).get_by_id(uuid.uuid4()) is None


async def test_database_constraints(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        category = Category(slug="dairy", name_uz="Sut", name_ru="Молоко")
        session.add(category)
        await session.flush()
        session.add(
            Product(
                category_id=category.id,
                sku="SKU-1",
                slug="milk",
                name_uz="Sut",
                name_ru="Молоко",
                unit=Unit.L,
                price_uzs=-1,
            )
        )
        with pytest.raises(IntegrityError, match="price_non_negative"):
            await session.flush()

    async with session_factory() as session:
        user = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(7, "Order Owner")
        )
        session.add(
            Order(
                number="MM-1",
                user_id=user.id,
                status=OrderStatus.CANCELLED,
                subtotal_uzs=1,
                delivery_fee_uzs=0,
                total_uzs=1,
                item_count=1,
                payment_method=PaymentMethod.CASH_ON_DELIVERY,
                recipient_name="x",
                recipient_phone="+998001234567",
                address_snapshot={"street": "x"},
                idempotency_key="test-key-0000000001",
                idempotency_request_hash="0" * 64,
            )
        )
        with pytest.raises(IntegrityError, match="cancelled_requires_reason"):
            await session.flush()
