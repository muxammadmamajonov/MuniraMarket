"""Data builders and an HTTP app on a real database, for the catalog, cart and order tests."""

import dataclasses
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, time
from typing import Any

from fastapi import FastAPI, Request
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api import admin_deps as admin_routes
from app.api import auth_deps
from app.api.deps import get_session
from app.api.routes import cart as cart_routes
from app.api.routes import orders as order_routes
from app.core.clock import Clock, system_clock
from app.main import create_app
from app.models.catalog import Category, Product
from app.models.delivery import DeliveryZone, DeliveryZoneDistrict
from app.models.enums import Unit, UserRole
from app.models.user import User
from app.repositories.users import SqlAlchemyUserRepository, TelegramProfile, UserRecord
from app.security.service_auth import InMemoryNonceStore
from tests.conftest import make_settings

SessionFactory = async_sessionmaker[AsyncSession]

TEST_USER_HEADER = "x-test-user"


async def add_category(
    factory: SessionFactory,
    slug: str,
    *,
    parent: Category | None = None,
    is_active: bool = True,
    sort_order: int = 0,
    name_uz: str | None = None,
    name_ru: str | None = None,
) -> Category:
    category = Category(
        slug=slug,
        parent_id=parent.id if parent else None,
        name_uz=name_uz or f"Demo {slug}",
        name_ru=name_ru or f"Демо {slug}",
        sort_order=sort_order,
        is_active=is_active,
    )
    async with factory() as session:
        session.add(category)
        await session.commit()
    return category


async def add_product(
    factory: SessionFactory,
    category: Category,
    slug: str,
    *,
    sku: str | None = None,
    name_uz: str | None = None,
    name_ru: str | None = None,
    price: int = 10_000,
    old_price: int | None = None,
    stock: int | None = None,
    is_active: bool = True,
    created_at: datetime | None = None,
    **extra: Any,
) -> Product:
    product = Product(
        category_id=category.id,
        slug=slug,
        sku=sku or f"DEMO-{slug}",
        name_uz=name_uz or f"Demo {slug}",
        name_ru=name_ru or f"Демо {slug}",
        unit=Unit.PIECE,
        price_uzs=price,
        old_price_uzs=old_price,
        stock_quantity=stock,
        is_active=is_active,
        **extra,
    )
    if created_at is not None:
        product.created_at = created_at
    async with factory() as session:
        session.add(product)
        await session.commit()
    return product


async def add_user(
    factory: SessionFactory,
    telegram_user_id: int | None = None,
    *,
    role: UserRole = UserRole.CUSTOMER,
) -> UserRecord:
    async with factory() as session:
        record = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(
                telegram_user_id=telegram_user_id or uuid.uuid4().int % 10**12,
                first_name="Demo User",
            )
        )
        if role is not UserRole.CUSTOMER:
            await session.execute(update(User).where(User.id == record.id).values(role=role))
            await session.commit()
            record = dataclasses.replace(record, role=role)
        return record


async def add_zone(
    factory: SessionFactory,
    slug: str,
    districts: Sequence[str],
    *,
    delivery_fee_uzs: int = 15_000,
    free_delivery_threshold_uzs: int | None = 300_000,
    min_order_uzs: int = 50_000,
    opens_at: time = time(9, 0),
    closes_at: time = time(21, 0),
    sort_order: int = 0,
    is_active: bool = True,
) -> DeliveryZone:
    zone = DeliveryZone(
        slug=slug,
        name_uz=f"Demo {slug}",
        name_ru=f"Демо {slug}",
        delivery_fee_uzs=delivery_fee_uzs,
        free_delivery_threshold_uzs=free_delivery_threshold_uzs,
        min_order_uzs=min_order_uzs,
        opens_at=opens_at,
        closes_at=closes_at,
        sort_order=sort_order,
        is_active=is_active,
    )
    async with factory() as session:
        session.add(zone)
        await session.flush()
        session.add_all(
            DeliveryZoneDistrict(district=district, zone_id=zone.id) for district in districts
        )
        await session.commit()
    return zone


async def update_row(
    factory: SessionFactory,
    model: type[Category] | type[Product] | type[DeliveryZone],
    row_id: uuid.UUID,
    **values: Any,
) -> None:
    async with factory() as session:
        await session.execute(update(model).where(model.id == row_id).values(**values))
        await session.commit()


# Every per-user / per-IP limit of the cart, checkout, order and admin routes.
RATE_LIMITS = (
    cart_routes.CART_READ_LIMIT,
    cart_routes.CART_WRITE_LIMIT,
    order_routes.ORDERS_IP_LIMIT,
    order_routes.CHECKOUT_QUOTE_LIMIT,
    order_routes.ORDER_CREATE_LIMIT,
    order_routes.ORDER_READ_LIMIT,
    order_routes.ORDER_CANCEL_LIMIT,
    admin_routes.ADMIN_IP_LIMIT,
    admin_routes.ADMIN_READ_LIMIT,
    admin_routes.ADMIN_WRITE_LIMIT,
)


def build_app(
    factory: SessionFactory,
    users: list[UserRecord] | None = None,
    *,
    clock: Clock = system_clock,
) -> FastAPI:
    """The real app + real repositories on the test schema.

    Session handling is stubbed (the auth work lands separately): the signed-in user is the one
    named by the ``x-test-user`` header (its id), else the first of ``users``. CSRF and the cart,
    checkout, order and admin rate limits are switched off.
    """
    app = create_app(make_settings(), clock=clock, nonce_store=InMemoryNonceStore(clock))
    by_id = {str(user.id): user for user in users or []}
    default = users[0] if users else None

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    async def current_user(request: Request) -> UserRecord:
        named = request.headers.get(TEST_USER_HEADER)
        user = by_id[named] if named else default
        assert user is not None, "no test user configured"
        return user

    async def allow() -> None:
        return None

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[auth_deps.get_current_user] = current_user
    app.dependency_overrides[auth_deps.require_csrf] = allow
    app.dependency_overrides[admin_routes.require_back_office_session] = allow
    for limit in RATE_LIMITS:
        app.dependency_overrides[limit] = allow
    return app
