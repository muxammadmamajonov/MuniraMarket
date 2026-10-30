"""Database-backed tests. Skipped unless TEST_DATABASE_URL points at a disposable PostgreSQL.

Every test run creates and drops its own schema, so nothing else in the database is touched.
"""

import os
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

import app.models  # noqa: F401
from app.db.base import Base
from app.domain.order_status import OrderStatus
from app.models.catalog import Category, Product
from app.models.enums import Language, PaymentMethod, Unit
from app.models.order import Order
from app.repositories.users import SqlAlchemyUserRepository, TelegramProfile

pytestmark = pytest.mark.integration


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    url = os.environ["TEST_DATABASE_URL"]
    schema = f"mm_test_{uuid.uuid4().hex[:12]}"
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    test_engine = create_async_engine(
        url, connect_args={"server_settings": {"search_path": schema}}
    )
    try:
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield test_engine
    finally:
        await test_engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()


@pytest.fixture
def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


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
                payment_method=PaymentMethod.CASH_ON_DELIVERY,
                recipient_name="x",
                recipient_phone="+998000000000",
                address_snapshot={"street": "x"},
            )
        )
        with pytest.raises(IntegrityError, match="cancelled_requires_reason"):
            await session.flush()
