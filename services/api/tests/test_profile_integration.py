"""Profile hub over HTTP against a real PostgreSQL schema built by the Alembic migrations.

``PATCH /me`` (name protection against Telegram sign-ins, phone verification semantics), the
saved addresses (limit, ownership, default switching and promotion, concurrency) and the order
history tabs with their thumbnails (filtered in SQL, two statements per page).
"""

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import delete, event, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from app.domain.order_status import OrderStatus
from app.models.address import UserAddress
from app.models.catalog import Category
from app.models.enums import PaymentMethod, Unit
from app.models.order import Order, OrderItem
from app.models.user import User
from app.repositories.users import SqlAlchemyUserRepository, TelegramProfile, UserRecord
from tests.db_data import (
    TEST_USER_HEADER,
    SessionFactory,
    add_category,
    add_product,
    add_user,
    build_app,
)
from tests.db_support import INTEGRATION_MARKS
from tests.test_service_auth import signed_headers

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS

ME = "/api/v1/me"
ADDRESSES = "/api/v1/me/addresses"
ORDERS = "/api/v1/orders"
SESSION = "/api/v1/internal/telegram/session"
ADDRESS = {"lat": 41.3110812, "lon": 69.2405624, "street": "Amir Temur", "house": "1"}


class Hub:
    def __init__(
        self,
        client: httpx.AsyncClient,
        factory: SessionFactory,
        users: list[UserRecord],
        category: Category,
    ) -> None:
        self.client = client
        self.factory = factory
        self.user, self.other = users
        self.category = category

    def headers(self, user: UserRecord | None = None) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.user).id)}

    async def patch(self, body: dict[str, Any], user: UserRecord | None = None) -> httpx.Response:
        return await self.client.patch(ME, json=body, headers=self.headers(user))

    async def add_address(self, user: UserRecord | None = None, **fields: Any) -> dict[str, Any]:
        response = await self.client.post(
            ADDRESSES, json={**ADDRESS, **fields}, headers=self.headers(user)
        )
        assert response.status_code == 201, response.text
        body: dict[str, Any] = response.json()
        return body

    async def addresses(self, user: UserRecord | None = None) -> list[dict[str, Any]]:
        response = await self.client.get(ADDRESSES, headers=self.headers(user))
        assert response.status_code == 200, response.text
        items: list[dict[str, Any]] = response.json()["items"]
        return items

    async def user_row(self, user: UserRecord | None = None) -> User:
        async with self.factory() as session:
            return (
                await session.execute(select(User).where(User.id == (user or self.user).id))
            ).scalar_one()

    async def telegram_session(self, telegram_user_id: int, **profile: Any) -> httpx.Response:
        body = json.dumps(
            {"telegram_user_id": telegram_user_id, **profile}, separators=(",", ":")
        ).encode()
        headers = signed_headers(
            method="POST",
            path=SESSION,
            body=body,
            actor=f"tg:{telegram_user_id}",
            timestamp=int(time.time()),
            nonce=f"nonce-{uuid.uuid4().hex}",
        )
        return await self.client.post(SESSION, content=body, headers=headers)


@pytest_asyncio.fixture(loop_scope="module")
async def hub(session_factory: SessionFactory) -> AsyncIterator[Hub]:
    users = [await add_user(session_factory), await add_user(session_factory)]
    category = await add_category(session_factory, "profile-cat")
    app = build_app(session_factory, users)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Hub(client, session_factory, users, category)


# --- PATCH /me ------------------------------------------------------------------------------------


async def test_patch_me_updates_only_the_sent_keys(hub: Hub) -> None:
    response = await hub.patch({"birth_date": "1990-05-17"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    user = response.json()["user"]
    assert (user["first_name"], user["last_name"], user["birth_date"]) == (
        "Demo User",
        None,
        "1990-05-17",
    )
    row = await hub.user_row()
    assert row.name_edited_at is None  # the name was not touched

    cleared = await hub.patch({"birth_date": None})
    assert cleared.json()["user"]["birth_date"] is None
    assert (await hub.user_row()).birth_date is None


async def test_edited_name_survives_telegram_sign_in(hub: Hub) -> None:
    telegram_id = hub.user.telegram_user_id
    # Before any edit, Telegram refreshes the name.
    first = await hub.telegram_session(telegram_id, first_name="Tg", last_name="Name")
    assert first.status_code == 200, first.text
    assert (first.json()["user"]["first_name"], first.json()["user"]["last_name"]) == (
        "Tg",
        "Name",
    )

    edited = await hub.patch({"first_name": "  Munira ", "last_name": "Karimova"})
    assert edited.status_code == 200, edited.text
    assert (await hub.user_row()).name_edited_at is not None

    again = await hub.telegram_session(
        telegram_id, first_name="Tg", last_name="Name", username="new_nick"
    )
    assert again.status_code == 200, again.text
    user = again.json()["user"]
    assert (user["first_name"], user["last_name"], user["username"]) == (
        "Munira",
        "Karimova",
        "new_nick",
    )
    # The init-data / OIDC sign-in path uses the same upsert.
    async with hub.factory() as session:
        record = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(telegram_id, "Other", "Person", "nick2")
        )
    assert (record.first_name, record.last_name, record.username) == (
        "Munira",
        "Karimova",
        "nick2",
    )

    # Clearing the last name is an edit too.
    cleared = await hub.patch({"last_name": "  "})
    assert cleared.json()["user"]["last_name"] is None


async def test_phone_semantics(hub: Hub) -> None:
    # A shared Telegram contact verified the number.
    async with hub.factory() as session:
        await SqlAlchemyUserRepository(session).record_telegram_phone(
            hub.user.telegram_user_id, "+998901234567"
        )

    same = await hub.patch({"phone": "90 123-45-67"})
    assert same.status_code == 200, same.text
    assert (same.json()["user"]["phone_verified"], same.json()["user"]["phone_hint"]) == (
        True,
        "+998 •• ••• 45 67",
    )
    row = await hub.user_row()
    assert (row.phone, row.phone_verification_method) == ("+998901234567", "telegram_contact")

    other = await hub.patch({"phone": "998 93 765 43 21"})
    assert other.status_code == 200, other.text
    user = other.json()["user"]
    assert (user["phone_verified"], user["phone_hint"]) == (False, "+998 •• ••• 43 21")
    assert "phone" not in user
    row = await hub.user_row()
    assert (row.phone, row.phone_verified_at, row.phone_verification_method) == (
        "+998937654321",
        None,
        None,
    )

    removed = await hub.patch({"phone": None})
    assert (removed.json()["user"]["phone_verified"], removed.json()["user"]["phone_hint"]) == (
        False,
        None,
    )
    row = await hub.user_row()
    assert (row.phone, row.phone_verified_at, row.phone_verification_method) == (None, None, None)


async def test_patch_me_validation_writes_nothing(hub: Hub) -> None:
    before = await hub.user_row()
    for body in ({}, {"first_name": None}, {"phone": "+7 912 345 67 89"}, {"x": 1}):
        response = await hub.patch(body)
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "validation_error"
    after = await hub.user_row()
    assert after.updated_at == before.updated_at


# --- saved addresses ------------------------------------------------------------------------------


async def test_address_crud_and_default_switching(hub: Hub) -> None:
    assert await hub.addresses() == []
    home = await hub.add_address(label=" Uy ", apartment="12")
    assert home["is_default"] is True  # the first address
    assert (home["lat"], home["lon"], home["label"], home["apartment"]) == (
        41.311081,
        69.240562,
        "Uy",
        "12",
    )
    work = await hub.add_address(label="Ish", is_default=False)
    assert work["is_default"] is False
    gym = await hub.add_address(label="Sport", is_default=True)
    assert gym["is_default"] is True

    listed = await hub.addresses()
    assert [item["label"] for item in listed] == ["Sport", "Ish", "Uy"]
    assert [item["is_default"] for item in listed] == [True, False, False]

    # PUT replaces every field; omitting is_default keeps it.
    replaced = await hub.client.put(
        f"{ADDRESSES}/{work['id']}",
        json={**ADDRESS, "street": "Navoiy", "label": None},
        headers=hub.headers(),
    )
    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert (body["street"], body["label"], body["apartment"], body["is_default"]) == (
        "Navoiy",
        None,
        None,
        False,
    )
    assert body["created_at"] == work["created_at"]
    assert body["updated_at"] > work["updated_at"]

    # is_default: true moves the default.
    moved = await hub.client.put(
        f"{ADDRESSES}/{home['id']}", json={**ADDRESS, "is_default": True}, headers=hub.headers()
    )
    assert moved.json()["is_default"] is True
    listed = await hub.addresses()
    assert [item["id"] for item in listed] == [home["id"], work["id"], gym["id"]]
    assert sum(item["is_default"] for item in listed) == 1

    # false on the default leaves no default.
    unset = await hub.client.put(
        f"{ADDRESSES}/{home['id']}", json={**ADDRESS, "is_default": False}, headers=hub.headers()
    )
    assert unset.json()["is_default"] is False
    assert not any(item["is_default"] for item in await hub.addresses())


async def test_deleting_the_default_promotes_the_most_recently_updated(hub: Hub) -> None:
    first = await hub.add_address(label="A")
    second = await hub.add_address(label="B")
    third = await hub.add_address(label="C")
    # Touch the second so it is the most recently updated of the remaining ones.
    await hub.client.put(
        f"{ADDRESSES}/{second['id']}", json={**ADDRESS, "label": "B2"}, headers=hub.headers()
    )
    assert first["is_default"] is True

    deleted = await hub.client.delete(f"{ADDRESSES}/{first['id']}", headers=hub.headers())
    assert deleted.status_code == 204
    assert deleted.content == b""
    listed = await hub.addresses()
    assert [(item["label"], item["is_default"]) for item in listed] == [
        ("B2", True),
        ("C", False),
    ]

    # Deleting a non-default changes nothing else.
    assert (
        await hub.client.delete(f"{ADDRESSES}/{third['id']}", headers=hub.headers())
    ).status_code == 204
    assert [(item["label"], item["is_default"]) for item in await hub.addresses()] == [("B2", True)]
    # Deleting the last one leaves nothing to promote.
    assert (
        await hub.client.delete(f"{ADDRESSES}/{second['id']}", headers=hub.headers())
    ).status_code == 204
    assert await hub.addresses() == []


async def test_another_users_address_is_not_found(hub: Hub) -> None:
    mine = await hub.add_address(label="Mine")
    theirs = await hub.add_address(user=hub.other, label="Theirs")

    for response in (
        await hub.client.put(
            f"{ADDRESSES}/{theirs['id']}",
            json={**ADDRESS, "is_default": True},
            headers=hub.headers(),
        ),
        await hub.client.delete(f"{ADDRESSES}/{theirs['id']}", headers=hub.headers()),
        await hub.client.delete(f"{ADDRESSES}/{uuid.uuid4()}", headers=hub.headers()),
    ):
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "address_not_found"

    # Nothing changed on either side (the refused is_default did not unset my default).
    assert [(item["id"], item["is_default"]) for item in await hub.addresses()] == [
        (mine["id"], True)
    ]
    other_items = await hub.addresses(hub.other)
    assert [(item["label"], item["is_default"]) for item in other_items] == [("Theirs", True)]


async def test_address_limit(hub: Hub) -> None:
    for index in range(10):
        await hub.add_address(label=f"A{index}")
    refused = await hub.client.post(ADDRESSES, json=ADDRESS, headers=hub.headers())
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "address_limit_reached"
    assert len(await hub.addresses()) == 10
    # The limit is per user.
    await hub.add_address(user=hub.other)


async def test_concurrent_creates_respect_limit_and_single_default(hub: Hub) -> None:
    responses = await asyncio.gather(
        *(
            hub.client.post(
                ADDRESSES, json={**ADDRESS, "label": f"C{index}"}, headers=hub.headers()
            )
            for index in range(14)
        )
    )
    statuses = sorted(response.status_code for response in responses)
    assert statuses == [201] * 10 + [409] * 4
    async with hub.factory() as session:
        rows = (
            await session.execute(
                select(UserAddress.is_default).where(UserAddress.user_id == hub.user.id)
            )
        ).scalars()
        flags = list(rows)
    assert len(flags) == 10
    assert flags.count(True) == 1


async def test_addresses_are_deleted_with_the_user(hub: Hub) -> None:
    await hub.add_address(user=hub.other)
    async with hub.factory() as session:
        await session.execute(delete(User).where(User.id == hub.other.id))
        await session.commit()
        remaining = (
            await session.execute(select(UserAddress).where(UserAddress.user_id == hub.other.id))
        ).all()
    assert remaining == []


# --- order history tabs and thumbnails ---------------------------------------------------------


async def _order(
    hub: Hub,
    status: OrderStatus,
    lines: list[tuple[Any, str]],
    *,
    user: UserRecord | None = None,
) -> uuid.UUID:
    """Insert an order with ``lines`` (product or ``None``, uz name) directly."""
    order_id = uuid.uuid4()
    async with hub.factory() as session:
        session.add(
            Order(
                id=order_id,
                number=f"T-{order_id.hex[:10]}",
                user_id=(user or hub.user).id,
                status=status,
                subtotal_uzs=1_000 * len(lines),
                total_uzs=1_000 * len(lines),
                item_count=len(lines),
                payment_method=PaymentMethod.CASH_ON_DELIVERY,
                recipient_name="Demo Mijoz",
                recipient_phone="+998001234567",
                address_snapshot={"lat": 41.3, "lon": 69.2, "street": "Demo", "house": "1"},
                cancel_reason="Demo" if status is OrderStatus.CANCELLED else None,
                idempotency_key=f"key-{order_id.hex}",
                idempotency_request_hash="0" * 64,
            )
        )
        await session.flush()
        for product, name in lines:
            session.add(
                OrderItem(
                    order_id=order_id,
                    product_id=product.id if product is not None else None,
                    sku=f"DEMO-{name}",
                    name_uz=name,
                    name_ru=f"ru-{name}",
                    unit=Unit.PIECE,
                    unit_price_uzs=1_000,
                    quantity=1,
                    line_total_uzs=1_000,
                )
            )
        await session.commit()
    return order_id


async def test_status_groups_filter_in_sql(hub: Hub) -> None:
    product = await add_product(hub.factory, hub.category, "p-group")
    by_status = {}
    for status in OrderStatus:
        by_status[status] = await _order(hub, status, [(product, "x")])
    await _order(hub, OrderStatus.NEW, [(product, "x")], user=hub.other)

    async def ids(group: str, **params: Any) -> tuple[set[str], int, int]:
        response = await hub.client.get(
            ORDERS, params={"status_group": group, **params}, headers=hub.headers()
        )
        assert response.status_code == 200, response.text
        body = response.json()
        return {item["id"] for item in body["items"]}, body["total"], body["total_pages"]

    def of(*statuses: OrderStatus) -> set[str]:
        return {str(by_status[status]) for status in statuses}

    assert await ids("all") == (of(*OrderStatus), 7, 1)
    assert await ids("active") == (
        of(
            OrderStatus.NEW,
            OrderStatus.CONFIRMED,
            OrderStatus.PICKING,
            OrderStatus.READY_FOR_DELIVERY,
        ),
        4,
        1,
    )
    assert await ids("delivering") == (of(OrderStatus.OUT_FOR_DELIVERY), 1, 1)
    assert await ids("done") == (of(OrderStatus.DELIVERED), 1, 1)
    assert await ids("cancelled") == (of(OrderStatus.CANCELLED), 1, 1)
    # Pagination counts the group only.
    page_two, total, pages = await ids("active", page=2, page_size=3)
    assert (len(page_two), total, pages) == (1, 4, 2)
    # Without the parameter: all.
    response = await hub.client.get(ORDERS, headers=hub.headers())
    assert response.json()["total"] == 7

    refused = await hub.client.get(ORDERS, params={"status_group": "open"}, headers=hub.headers())
    assert refused.status_code == 422
    assert refused.json()["error"]["details"][0]["loc"] == ["query", "status_group"]


async def test_thumbnails_use_current_images_in_line_order(hub: Hub, engine: AsyncEngine) -> None:
    with_image = await add_product(
        hub.factory, hub.category, "p-img", image_url="https://img.example.com/a.webp"
    )
    without_image = await add_product(hub.factory, hub.category, "p-noimg")
    names = ["f", "b", "e", "a", "d", "c"]
    products = [with_image, without_image, None, with_image, without_image, with_image]
    big = await _order(hub, OrderStatus.NEW, list(zip(products, names, strict=True)))
    empty_lines = await _order(hub, OrderStatus.DELIVERED, [(None, "z")])
    for index in range(3):
        await _order(hub, OrderStatus.CONFIRMED, [(with_image, f"n{index}")] * 5)

    # The product's image changes after the order: the thumbnail shows the current one.
    async with hub.factory() as session:
        await session.execute(
            update(type(with_image))
            .where(type(with_image).id == with_image.id)
            .values(image_url="https://img.example.com/new.webp")
        )
        await session.commit()

    statements: list[str] = []

    def count(*args: Any) -> None:
        statements.append(str(args[2]))

    event.listen(engine.sync_engine, "before_cursor_execute", count)
    try:
        response = await hub.client.get(ORDERS, params={"page_size": 50}, headers=hub.headers())
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", count)
    assert response.status_code == 200, response.text
    # One count and one page query, whatever the number of orders and lines.
    assert len(statements) == 2, statements

    items = {item["id"]: item for item in response.json()["items"]}
    thumbnails = items[str(big)]["thumbnails"]
    # The first four lines in the order detail's order (name_uz, then id).
    assert [thumb["name_uz"] for thumb in thumbnails] == ["a", "b", "c", "d"]
    assert thumbnails[0] == {
        "product_id": str(with_image.id),
        "name_uz": "a",
        "name_ru": "ru-a",
        "image_url": "https://img.example.com/new.webp",
    }
    assert thumbnails[1]["image_url"] is None  # product without an image
    assert thumbnails[3]["image_url"] is None
    detail = await hub.client.get(f"{ORDERS}/{big}", headers=hub.headers())
    assert [line["name_uz"] for line in detail.json()["items"]][:4] == ["a", "b", "c", "d"]

    # A deleted product: no product id, no image, the snapshot names stay.
    assert items[str(empty_lines)]["thumbnails"] == [
        {"product_id": None, "name_uz": "z", "name_ru": "ru-z", "image_url": None}
    ]
    assert all(len(item["thumbnails"]) <= 4 for item in items.values())
