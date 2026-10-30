"""Data builders and an HTTP app on a real database, for the catalog/cart integration tests."""

import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from fastapi import FastAPI, Request
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api import auth_deps
from app.api.deps import get_session
from app.api.routes import cart as cart_routes
from app.main import create_app
from app.models.catalog import Category, Product
from app.models.enums import Unit
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


async def add_user(factory: SessionFactory, telegram_user_id: int | None = None) -> UserRecord:
    async with factory() as session:
        return await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(
                telegram_user_id=telegram_user_id or uuid.uuid4().int % 10**12,
                first_name="Demo User",
            )
        )


async def update_row(
    factory: SessionFactory, model: type[Category] | type[Product], row_id: uuid.UUID, **values: Any
) -> None:
    async with factory() as session:
        await session.execute(update(model).where(model.id == row_id).values(**values))
        await session.commit()


def build_app(factory: SessionFactory, users: list[UserRecord] | None = None) -> FastAPI:
    """The real app + real repositories on the test schema.

    Session handling is stubbed (the auth work lands separately): the signed-in user is the one
    named by the ``x-test-user`` header (its id), else the first of ``users``. CSRF and the cart
    rate limits are switched off.
    """
    app = create_app(make_settings(), nonce_store=InMemoryNonceStore())
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
    app.dependency_overrides[cart_routes.CART_READ_LIMIT] = allow
    app.dependency_overrides[cart_routes.CART_WRITE_LIMIT] = allow
    return app
