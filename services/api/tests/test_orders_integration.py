"""Checkout and orders over HTTP against a real PostgreSQL schema built by the Alembic migrations.

Covers the quote (total = subtotal: the customer pays the Yandex Go courier), the order
transaction (stock, snapshots, cart, history, outbox), idempotency, refusals that must leave
nothing behind, cancellation and the operator lifecycle, user isolation and, with real concurrent
requests, the locking strategy.
"""

import asyncio
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select

from app.domain.checkout import MAX_OPEN_ORDERS
from app.domain.order_status import OrderStatus
from app.models.cart import CartItem
from app.models.catalog import Category, Product
from app.models.enums import UserRole
from app.models.notification import NotificationOutbox, StaffNotificationChat
from app.models.order import Order, OrderItemAdjustment, OrderStatusHistory
from app.repositories import orders as order_repository
from app.repositories.users import UserRecord
from tests.db_data import (
    TEST_USER_HEADER,
    SessionFactory,
    add_category,
    add_product,
    add_user,
    build_app,
    update_row,
)
from tests.db_support import INTEGRATION_MARKS
from tests.order_factories import DEMO_PHONE, order_body

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS

QUOTE = "/api/v1/checkout/quote"
ORDERS = "/api/v1/orders"
ADMIN = "/api/v1/admin/orders"
ITEMS = "/api/v1/cart/items"
EXTRA_CUSTOMERS = 8
ORDER_NUMBER = re.compile(r"\d{6}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}")


def new_key() -> str:
    return str(uuid.uuid4())


class Shop:
    """Signed-in customers and an operator, and a catalog category."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        factory: SessionFactory,
        users: list[UserRecord],
        category: Category,
    ) -> None:
        self.client = client
        self.factory = factory
        self.user, self.other_user, self.operator, *self.crowd = users
        self.category = category

    # --- data ---

    async def product(self, slug: str, **kwargs: Any) -> Product:
        return await add_product(self.factory, self.category, slug, **kwargs)

    async def stock(self, product: Product) -> int | None:
        async with self.factory() as session:
            return (
                await session.execute(
                    select(Product.stock_quantity).where(Product.id == product.id)
                )
            ).scalar_one()

    async def count(self, model: type[Any], *where: Any) -> int:
        async with self.factory() as session:
            return (
                await session.execute(select(func.count()).select_from(model).where(*where))
            ).scalar_one()

    async def outbox(self, order_id: str) -> list[NotificationOutbox]:
        async with self.factory() as session:
            rows = await session.execute(
                select(NotificationOutbox)
                .where(NotificationOutbox.order_id == uuid.UUID(order_id))
                .order_by(NotificationOutbox.created_at, NotificationOutbox.id)
            )
            return list(rows.scalars())

    async def history(self, order_id: str) -> list[OrderStatusHistory]:
        async with self.factory() as session:
            rows = await session.execute(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == uuid.UUID(order_id))
                .order_by(OrderStatusHistory.created_at, OrderStatusHistory.id)
            )
            return list(rows.scalars())

    # --- requests ---

    def headers(self, user: UserRecord | None = None, **extra: str) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.user).id), **extra}

    async def add(
        self, product: Product, quantity: int = 1, *, user: UserRecord | None = None
    ) -> None:
        response = await self.client.post(
            ITEMS,
            json={"product_id": str(product.id), "quantity": quantity},
            headers=self.headers(user),
        )
        assert response.status_code == 200, response.text

    async def quote(self, *, user: UserRecord | None = None) -> Any:
        return await self.client.post(QUOTE, headers=self.headers(user))

    async def quoted_total(self, *, user: UserRecord | None = None) -> int:
        response = await self.quote(user=user)
        assert response.status_code == 200, response.text
        total: int = response.json()["total_uzs"]
        return total

    async def order(
        self,
        expected_total_uzs: int,
        *,
        key: str | None = None,
        user: UserRecord | None = None,
        **overrides: Any,
    ) -> httpx.Response:
        return await self.client.post(
            ORDERS,
            json=order_body(expected_total_uzs=expected_total_uzs, **overrides),
            headers=self.headers(user, **{"Idempotency-Key": key or new_key()}),
        )

    async def place(self, *, user: UserRecord | None = None) -> dict[str, Any]:
        """Order whatever is in the user's cart at the quoted total."""
        response = await self.order(await self.quoted_total(user=user), user=user)
        assert response.status_code == 201, response.text
        body: dict[str, Any] = response.json()
        return body

    async def cancel(
        self, order_id: str, reason: str = "Fikrim o'zgardi", *, user: UserRecord | None = None
    ) -> httpx.Response:
        return await self.client.post(
            f"{ORDERS}/{order_id}/cancel", json={"reason": reason}, headers=self.headers(user)
        )

    async def move(self, order_id: str, status: str, **fields: Any) -> httpx.Response:
        return await self.client.patch(
            f"{ADMIN}/{order_id}/status",
            json={"status": status, **fields},
            headers=self.headers(self.operator),
        )


@pytest_asyncio.fixture(loop_scope="module")
async def shop(session_factory: SessionFactory) -> AsyncIterator[Shop]:
    users = [
        await add_user(session_factory),
        await add_user(session_factory),
        await add_user(session_factory, role=UserRole.OPERATOR),
    ]
    users += [await add_user(session_factory) for _ in range(EXTRA_CUSTOMERS)]
    category = await add_category(session_factory, "orders-cat")
    app = build_app(session_factory, users)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Shop(client, session_factory, users, category)


def error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- quote ----------------------------------------------------------------------------------------


async def test_quote_total_is_the_subtotal(shop: Shop) -> None:
    await shop.add(await shop.product("apple", price=25_000), 2)
    response = await shop.quote()
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["subtotal_uzs"], body["total_uzs"]) == (50_000, 50_000)
    assert body["issues"] == []
    assert body["can_place_order"] is True


async def test_any_amount_can_be_ordered(shop: Shop) -> None:
    # No minimum order and no delivery charge: delivery is on demand by a Yandex Go courier.
    await shop.add(await shop.product("cheap", price=1_000))
    body = (await shop.quote()).json()
    assert (body["total_uzs"], body["issues"], body["can_place_order"]) == (1_000, [], True)
    order = await shop.place()
    assert (order["subtotal_uzs"], order["total_uzs"]) == (1_000, 1_000)


async def test_empty_cart(shop: Shop) -> None:
    body = (await shop.quote()).json()
    assert body["issues"] == ["cart_empty"]
    assert body["total_uzs"] == 0
    error(await shop.order(0), 409, "cart_empty")
    # A cart that existed but was emptied is refused the same way.
    apple = await shop.product("apple")
    await shop.add(apple)
    await shop.client.delete(f"{ITEMS}/{apple.id}", headers=shop.headers())
    error(await shop.order(0), 409, "cart_empty")


# --- placing an order -----------------------------------------------------------------------------


async def test_happy_path(shop: Shop) -> None:
    tracked = await shop.product("tracked", price=25_000, stock=10, sku="DEMO-0100")
    untracked = await shop.product("untracked", price=10_000, stock=None, sku="DEMO-0200")
    await shop.add(tracked, 2)
    await shop.add(untracked, 3)
    total = await shop.quoted_total()
    assert total == 80_000

    response = await shop.order(
        total,
        recipient_phone="+998 00 123-45-67",
        comment=" Demo izoh ",
        address={
            "lat": 41.3110814999,
            "lon": 69.2405625,
            "street": " Demo ko'cha ",
            "house": "7",
            "floor": "",
        },
    )
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "idempotent-replayed" not in response.headers
    order = response.json()
    assert ORDER_NUMBER.fullmatch(order["number"])
    assert order["status"] == "NEW"
    assert (order["subtotal_uzs"], order["total_uzs"]) == (80_000, 80_000)
    assert order["item_count"] == 5
    assert order["recipient_phone"] == DEMO_PHONE
    assert order["comment"] == "Demo izoh"
    assert order["address"]["street"] == "Demo ko'cha"
    assert order["address"]["floor"] is None
    # The map point is stored with 6 decimals.
    assert (order["address"]["lat"], order["address"]["lon"]) == (41.311081, 69.240562)
    assert order["can_cancel"] is True
    assert [change["status"] for change in order["history"]] == ["NEW"]
    lines = {line["sku"]: line for line in order["items"]}
    assert lines["DEMO-0100"] == {
        "product_id": str(tracked.id),
        "sku": "DEMO-0100",
        "name_uz": "Demo tracked",
        "name_ru": "Демо tracked",
        "unit": "piece",
        "unit_price_uzs": 25_000,
        "quantity": 2,
        "line_total_uzs": 50_000,
        "original_quantity": 2,
        "adjusted": False,
    }
    assert lines["DEMO-0200"]["line_total_uzs"] == 30_000

    # Stock: decremented for tracked products only.
    assert await shop.stock(tracked) == 8
    assert await shop.stock(untracked) is None
    # The cart is emptied.
    assert await shop.count(CartItem) == 0
    cart = (await shop.client.get("/api/v1/cart", headers=shop.headers())).json()
    assert cart["items"] == []
    # The address snapshot is what was validated (trimmed, blanks as null, 6-decimal point).
    async with shop.factory() as session:
        stored = (
            await session.execute(select(Order).where(Order.id == uuid.UUID(order["id"])))
        ).scalar_one()
    assert stored.address_snapshot == {
        "lat": 41.311081,
        "lon": 69.240562,
        "street": "Demo ko'cha",
        "house": "7",
        "apartment": None,
        "entrance": None,
        "floor": None,
        "landmark": None,
    }
    assert len(stored.idempotency_request_hash) == 64

    # History: one NEW entry by the customer.
    [created] = await shop.history(order["id"])
    assert (created.from_status, created.to_status) == (None, OrderStatus.NEW)
    assert (created.actor_role, created.actor_user_id) == (UserRole.CUSTOMER, shop.user.id)

    # Outbox: exactly one row, enough to notify, nothing personal.
    [message] = await shop.outbox(order["id"])
    assert message.event_type == "order.status_changed"
    assert message.processed_at is None
    assert message.attempts == 0
    assert message.payload == {
        "order_id": order["id"],
        "order_number": order["number"],
        "status": "NEW",
        "locale": "uz",
        "total_uzs": 80_000,
        "chat_id": shop.user.telegram_user_id,
    }
    serialized = str(message.payload)
    # The full phone (and its local part), not a bare "998": random UUIDs in the payload can
    # contain that digit run.
    for personal in (
        DEMO_PHONE,
        DEMO_PHONE[4:],
        "Demo ko'cha",
        "Demo Mijoz",
        "41.311081",
        "Demo izoh",
    ):
        assert personal not in serialized

    # Snapshots survive catalog changes.
    await update_row(shop.factory, Product, tracked.id, price_uzs=99_000, name_uz="Demo yangi")
    again = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert again["items"] == order["items"]
    assert again["total_uzs"] == 80_000


# --- idempotency ----------------------------------------------------------------------------------


async def test_same_key_and_body_replays_the_order(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=5)
    await shop.add(apple, 2)
    total = await shop.quoted_total()
    key = new_key()

    first = await shop.order(total, key=key)
    assert first.status_code == 201
    # Cosmetically different but equivalent body: still a replay.
    second = await shop.order(total, key=key, recipient_phone="+998 (00) 123 45 67")
    assert second.status_code == 200, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json() == first.json()
    assert await shop.count(Order) == 1
    assert await shop.count(NotificationOutbox) == 1
    assert await shop.stock(apple) == 3

    # Same key, different body.
    conflict = await shop.order(total, key=key, recipient_name="Boshqa Mijoz")
    error(conflict, 409, "idempotency_key_conflict")
    assert await shop.count(Order) == 1

    # Keys are per user: another customer may use the same one.
    await shop.add(apple, 1, user=shop.other_user)
    other = await shop.order(total, key=key, user=shop.other_user)
    error(other, 409, "price_changed")  # proves it was evaluated, not replayed
    other = await shop.order(30_000, key=key, user=shop.other_user)
    assert other.status_code == 201
    assert other.json()["id"] != first.json()["id"]


async def test_concurrent_requests_with_one_key_create_one_order(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=10)
    await shop.add(apple, 2)
    total = await shop.quoted_total()
    key = new_key()

    responses = await asyncio.gather(*(shop.order(total, key=key) for _ in range(6)))
    statuses = sorted(response.status_code for response in responses)
    assert statuses == [200, 200, 200, 200, 200, 201], [r.text for r in responses]
    assert len({response.json()["id"] for response in responses}) == 1
    assert sum(r.headers.get("idempotent-replayed") == "true" for r in responses) == 5
    assert await shop.count(Order) == 1
    assert await shop.count(OrderStatusHistory) == 1
    assert await shop.count(NotificationOutbox) == 1
    assert await shop.stock(apple) == 8


# --- stock race -----------------------------------------------------------------------------------


async def test_parallel_orders_never_oversell(shop: Shop) -> None:
    scarce = await shop.product("scarce", price=60_000, stock=3)
    buyers = shop.crowd
    assert len(buyers) == 8
    for buyer in buyers:
        await shop.add(scarce, 1, user=buyer)

    responses = await asyncio.gather(*(shop.order(60_000, user=buyer) for buyer in buyers))
    created = [r for r in responses if r.status_code == 201]
    refused = [r for r in responses if r.status_code != 201]
    assert len(created) == 3, [r.text for r in responses]
    assert len(refused) == 5
    for response in refused:
        body = error(response, 409, "insufficient_stock")
        assert body["available_quantity"] == 0
        assert body["product_id"] == str(scarce.id)
    assert await shop.stock(scarce) == 0
    assert await shop.count(Order) == 3
    assert await shop.count(NotificationOutbox) == 3
    # The refused buyers keep their carts.
    assert await shop.count(CartItem) == 5


async def test_parallel_orders_of_overlapping_carts_do_not_deadlock(shop: Shop) -> None:
    first = await shop.product("first", price=30_000, stock=50)
    second = await shop.product("second", price=30_000, stock=50)
    # Lines added in opposite orders: product locks are still taken in id order.
    for index, buyer in enumerate(shop.crowd):
        pair = (first, second) if index % 2 else (second, first)
        for product in pair:
            await shop.add(product, 1, user=buyer)
    responses = await asyncio.gather(*(shop.order(60_000, user=buyer) for buyer in shop.crowd))
    assert [r.status_code for r in responses] == [201] * len(shop.crowd), [
        r.text for r in responses
    ]
    assert await shop.stock(first) == 50 - len(shop.crowd)
    assert await shop.stock(second) == 50 - len(shop.crowd)


# --- refusals leave nothing behind ----------------------------------------------------------------


async def test_price_change_between_quote_and_order(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=5)
    await shop.add(apple, 2)
    shown = await shop.quoted_total()
    assert shown == 60_000

    await update_row(shop.factory, Product, apple.id, price_uzs=35_000)
    body = error(await shop.order(shown), 409, "price_changed")
    assert body["total_uzs"] == 70_000
    assert await shop.stock(apple) == 5
    assert await shop.count(CartItem) == 1
    assert await shop.count(Order) == 0
    assert await shop.count(OrderStatusHistory) == 0
    assert await shop.count(NotificationOutbox) == 0

    # Ordering at the new total works.
    assert (await shop.order(70_000)).status_code == 201


async def test_inactive_products_are_refused(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    total = await shop.quoted_total()

    await update_row(shop.factory, Product, apple.id, is_active=False)
    quote = (await shop.quote()).json()
    assert quote["issues"] == ["cart_has_issues"]
    body = error(await shop.order(total), 409, "product_inactive")
    assert body["product_id"] == str(apple.id)

    # An inactive category hides the product just the same.
    await update_row(shop.factory, Product, apple.id, is_active=True)
    await update_row(shop.factory, Category, shop.category.id, is_active=False)
    body = error(await shop.order(total), 409, "product_inactive")
    assert body["product_id"] == str(apple.id)
    assert await shop.stock(apple) == 5
    assert await shop.count(Order) == 0
    assert await shop.count(CartItem) == 1


async def test_stock_dropped_below_the_cart_quantity(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=5)
    await shop.add(apple, 4)
    total = await shop.quoted_total()
    await update_row(shop.factory, Product, apple.id, stock_quantity=3)
    body = error(await shop.order(total), 409, "insufficient_stock")
    assert (body["available_quantity"], body["product_id"]) == (3, str(apple.id))
    assert await shop.stock(apple) == 3
    assert await shop.count(Order) == 0


# --- cancellation ---------------------------------------------------------------------------------


async def test_customer_cancel_restocks(shop: Shop) -> None:
    tracked = await shop.product("tracked", price=25_000, stock=10)
    untracked = await shop.product("untracked", price=10_000)
    await shop.add(tracked, 2)
    await shop.add(untracked, 1)
    order = await shop.place()
    assert await shop.stock(tracked) == 8

    response = await shop.cancel(order["id"], "  Fikrim o'zgardi  ")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["status"] == "CANCELLED"
    assert body["cancel_reason"] == "Fikrim o'zgardi"
    assert body["can_cancel"] is False
    assert [change["status"] for change in body["history"]] == ["NEW", "CANCELLED"]
    assert await shop.stock(tracked) == 10
    assert await shop.stock(untracked) is None

    _, cancelled = await shop.history(order["id"])
    assert (cancelled.from_status, cancelled.to_status) == (OrderStatus.NEW, OrderStatus.CANCELLED)
    assert (cancelled.actor_role, cancelled.actor_user_id) == (UserRole.CUSTOMER, shop.user.id)
    assert cancelled.reason == "Fikrim o'zgardi"
    _, message = await shop.outbox(order["id"])
    assert message.payload["status"] == "CANCELLED"
    assert message.payload["cancel_reason"] == "Fikrim o'zgardi"

    # Cancelling twice is refused and returns nothing twice.
    body = error(await shop.cancel(order["id"]), 409, "order_not_cancellable")
    assert body["current_status"] == "CANCELLED"
    assert await shop.stock(tracked) == 10
    assert len(await shop.outbox(order["id"])) == 2


async def test_cancel_returns_only_stock_the_order_took(shop: Shop) -> None:
    # Untracked when ordered; tracking switched on before the order is cancelled.
    product = await shop.product("later-tracked", price=60_000)
    await shop.add(product, 2)
    order = await shop.place()
    await update_row(shop.factory, Product, product.id, stock_quantity=5)

    assert (await shop.cancel(order["id"])).status_code == 200
    assert await shop.stock(product) == 5


async def test_open_orders_per_customer_are_capped(shop: Shop) -> None:
    product = await shop.product("capped", price=60_000, stock=100)
    for _ in range(MAX_OPEN_ORDERS):
        await shop.add(product, 1)
        await shop.place()
    await shop.add(product, 1)
    error(await shop.order(await shop.quoted_total()), 409, "too_many_open_orders")
    assert await shop.stock(product) == 100 - MAX_OPEN_ORDERS

    # Once one is confirmed, there is room again.
    [newest, *_] = (await shop.client.get(ORDERS, headers=shop.headers())).json()["items"]
    assert (await shop.move(newest["id"], "CONFIRMED")).status_code == 200
    await shop.place()


async def test_customer_cancel_is_refused_once_picking(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    order = await shop.place()
    assert (await shop.move(order["id"], "CONFIRMED")).status_code == 200
    # Still cancellable when confirmed ...
    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["can_cancel"] is True
    assert (await shop.move(order["id"], "PICKING")).status_code == 200
    # ... but not once picking has started.
    body = error(await shop.cancel(order["id"]), 409, "order_not_cancellable")
    assert body["current_status"] == "PICKING"
    assert await shop.stock(apple) == 4
    assert len(await shop.history(order["id"])) == 3


# --- operator lifecycle ---------------------------------------------------------------------------


async def test_operator_moves_an_order_through_its_lifecycle(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    order = await shop.place()
    order_id = order["id"]

    body = error(await shop.move(order_id, "PICKING"), 409, "invalid_status_transition")
    assert body["current_status"] == "NEW"
    body = error(
        await shop.move(order_id, "CONFIRMED", expected_status="CONFIRMED"),
        409,
        "order_status_conflict",
    )
    assert body["current_status"] == "NEW"

    response = await shop.move(order_id, "CONFIRMED", expected_status="NEW")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    detail = response.json()
    assert detail["status"] == "CONFIRMED"
    assert detail["allowed_transitions"] == ["PICKING", "CANCELLED"]
    assert detail["history_detail"][-1]["actor_role"] == "operator"

    for status in ("PICKING", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"):
        assert (await shop.move(order_id, status)).status_code == 200
    error(
        await shop.move(order_id, "CANCELLED", reason="Kech qoldi"),
        409,
        "invalid_status_transition",
    )

    history = await shop.history(order_id)
    assert [change.to_status.value for change in history] == [
        "NEW",
        "CONFIRMED",
        "PICKING",
        "READY_FOR_DELIVERY",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
    ]
    assert all(change.actor_user_id == shop.operator.id for change in history[1:])
    assert [m.payload["status"] for m in await shop.outbox(order_id)] == [
        change.to_status.value for change in history
    ]
    # Delivered stock stays sold.
    assert await shop.stock(apple) == 4


async def test_operator_cancel_needs_a_reason_and_restocks(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=5)
    await shop.add(apple, 2)
    order = await shop.place()
    for status in ("CONFIRMED", "PICKING", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY"):
        assert (await shop.move(order["id"], status)).status_code == 200
    assert await shop.stock(apple) == 3

    # Without a reason: refused as a transition (a blank one fails validation).
    error(await shop.move(order["id"], "CANCELLED"), 409, "invalid_status_transition")
    error(await shop.move(order["id"], "CANCELLED", reason="  "), 422, "validation_error")
    assert await shop.stock(apple) == 3

    response = await shop.move(order["id"], "CANCELLED", reason="Mijoz javob bermadi")
    assert response.status_code == 200, response.text
    assert response.json()["cancel_reason"] == "Mijoz javob bermadi"
    assert response.json()["allowed_transitions"] == []
    assert await shop.stock(apple) == 5
    last = (await shop.history(order["id"]))[-1]
    assert (last.actor_role, last.reason) == (UserRole.OPERATOR, "Mijoz javob bermadi")
    assert (await shop.outbox(order["id"]))[-1].payload["cancel_reason"] == "Mijoz javob bermadi"


async def test_concurrent_cancels_restock_once(shop: Shop) -> None:
    apple = await shop.product("apple", price=30_000, stock=5)
    await shop.add(apple, 2)
    order = await shop.place()
    responses = await asyncio.gather(
        shop.cancel(order["id"]),
        shop.cancel(order["id"]),
        shop.move(order["id"], "CANCELLED", reason="Operator bekor qildi"),
    )
    assert sorted(r.status_code for r in responses) == [200, 409, 409]
    assert await shop.stock(apple) == 5
    assert len(await shop.outbox(order["id"])) == 2


async def test_staff_group_gets_alerts_for_new_orders_and_key_statuses(shop: Shop) -> None:
    """ADR 0015: with a group connected, the same transaction also enqueues staff alerts for
    NEW, OUT_FOR_DELIVERY, DELIVERED and CANCELLED. Every alert names the recipient; the NEW
    alert carries the whole order (owner's request) for the private staff group."""
    plain = await shop.product("plain", price=30_000, stock=10)
    await shop.add(plain, 2)
    before = await shop.place()  # no group yet: customer notification only
    assert [m.event_type for m in await shop.outbox(before["id"])] == ["order.status_changed"]
    assert (await shop.cancel(before["id"])).status_code == 200

    async with shop.factory() as session:
        session.add(StaffNotificationChat(id=1, chat_id=-1001234567890))
        await session.commit()

    apple = await shop.product("apple", price=30_000, stock=10)
    await shop.add(apple, 2)
    order = await shop.place()
    for status in ("CONFIRMED", "PICKING", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"):
        assert (await shop.move(order["id"], status)).status_code == 200
    alerts = [m for m in await shop.outbox(order["id"]) if m.event_type == "order.staff_alert"]
    assert [m.payload["status"] for m in alerts] == ["NEW", "OUT_FOR_DELIVERY", "DELIVERED"]
    assert all(m.payload["chat_id"] == -1001234567890 for m in alerts)
    assert alerts[0].payload["previous_status"] is None
    assert set(alerts[0].payload) == {
        "order_id",
        "order_number",
        "status",
        "previous_status",
        "total_uzs",
        "chat_id",
        "cancelled_by_customer",
        "recipient_name",
        "details",
        "destination",
    }
    # The drop-off point (for the "call a Yandex Go courier" button), only on the NEW alert.
    assert alerts[0].payload["destination"] == {"lat": 41.311081, "lon": 69.240562}
    assert all("destination" not in m.payload for m in alerts[1:])
    assert all(m.payload["recipient_name"] == "Demo Mijoz" for m in alerts)
    details = alerts[0].payload["details"]
    assert details["items"] == [
        {"name_uz": "Demo apple", "quantity": 2, "unit": "piece", "line_total_uzs": 60_000}
    ]
    assert (details["subtotal_uzs"], details["payment_method"]) == (60_000, "cash_on_delivery")
    assert details["recipient_phone"] == DEMO_PHONE
    assert details["address"] == {
        "street": "Demo ko'cha",
        "house": "12",
        "apartment": None,
        "entrance": None,
        "floor": None,
        "landmark": None,
    }
    assert details["comment"] is None
    assert details["created_at"].endswith("+00:00")
    assert all("details" not in m.payload for m in alerts[1:])
    customer = [m for m in await shop.outbox(order["id"]) if m.event_type != "order.staff_alert"]
    assert len(customer) == 6  # the customer's own notifications are unchanged

    await shop.add(apple, 2)
    cancelled = await shop.place()
    assert (await shop.cancel(cancelled["id"])).status_code == 200
    [_, cancel_alert] = [
        m for m in await shop.outbox(cancelled["id"]) if m.event_type == "order.staff_alert"
    ]
    assert cancel_alert.payload["status"] == "CANCELLED"
    assert cancel_alert.payload["cancelled_by_customer"] is True
    assert "destination" not in cancel_alert.payload


async def test_an_order_placed_before_courier_delivery_reads_without_coordinates(
    shop: Shop,
) -> None:
    """A stored address of the old shape (no map point, an area key) reads as null coordinates."""
    apple = await shop.product("apple", price=30_000, stock=10)
    await shop.add(apple)
    order = await shop.place()
    async with shop.factory() as session:
        stored = await session.get(Order, uuid.UUID(order["id"]))
        assert stored is not None
        stored.address_snapshot = {"region": "chilonzor", "street": "Demo ko'cha", "house": "1"}
        await session.commit()
    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["address"]["lat"] is None
    assert detail["address"]["lon"] is None
    assert detail["address"]["street"] == "Demo ko'cha"
    assert "region" not in detail["address"]


# --- isolation ------------------------------------------------------------------------------------


async def test_other_customers_orders_are_invisible(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    order = await shop.place()
    stranger = shop.other_user

    for response in (
        await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers(stranger)),
        await shop.cancel(order["id"], user=stranger),
        await shop.client.get(f"{ORDERS}/{uuid.uuid4()}", headers=shop.headers(stranger)),
    ):
        assert response.json() == {
            "error": {"code": "order_not_found", "message": "Order not found"}
        }
        assert response.status_code == 404
    listing = (await shop.client.get(ORDERS, headers=shop.headers(stranger))).json()
    assert listing["items"] == []
    # Customers cannot use the back office either.
    error(await shop.client.get(ADMIN, headers=shop.headers(stranger)), 403, "forbidden")
    response = await shop.client.patch(
        f"{ADMIN}/{order['id']}/status",
        json={"status": "CANCELLED", "reason": "Begona"},
        headers=shop.headers(stranger),
    )
    error(response, 403, "forbidden")

    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["status"] == "NEW"
    assert await shop.stock(apple) == 4
    assert len(await shop.history(order["id"])) == 1


async def test_customer_order_list_is_newest_first_and_paginated(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=50)
    placed = []
    for _ in range(3):
        await shop.add(apple)
        placed.append(await shop.place())
    await shop.add(apple, user=shop.other_user)
    theirs = await shop.place(user=shop.other_user)

    first = (await shop.client.get(ORDERS, params={"page_size": 2}, headers=shop.headers())).json()
    assert (first["total"], first["total_pages"], first["page"]) == (3, 2, 1)
    second = (
        await shop.client.get(ORDERS, params={"page": 2, "page_size": 2}, headers=shop.headers())
    ).json()
    ids = [item["id"] for item in first["items"] + second["items"]]
    assert ids == [order["id"] for order in reversed(placed)]
    assert set(first["items"][0]) == {
        "id",
        "number",
        "status",
        "total_uzs",
        "item_count",
        "created_at",
        "thumbnails",
    }
    beyond = (
        await shop.client.get(ORDERS, params={"page": 9, "page_size": 2}, headers=shop.headers())
    ).json()
    assert (beyond["items"], beyond["total"]) == ([], 3)

    other = (await shop.client.get(ORDERS, headers=shop.headers(shop.other_user))).json()
    assert [item["id"] for item in other["items"]] == [theirs["id"]]


async def test_admin_list_filters_by_status(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=50)
    placed = []
    for user in (shop.user, shop.other_user, shop.user):
        await shop.add(apple, user=user)
        placed.append(await shop.place(user=user))
    assert (await shop.move(placed[1]["id"], "CONFIRMED")).status_code == 200

    def listing(**params: Any) -> Any:
        return shop.client.get(ADMIN, params=params, headers=shop.headers(shop.operator))

    everything = (await listing()).json()
    assert [item["id"] for item in everything["items"]] == [o["id"] for o in reversed(placed)]
    confirmed = (await listing(status="CONFIRMED")).json()
    assert [item["id"] for item in confirmed["items"]] == [placed[1]["id"]]
    assert confirmed["total"] == 1
    new = (await listing(status="NEW", page_size=1)).json()
    assert (new["total"], new["total_pages"], len(new["items"])) == (2, 2, 1)
    assert (await listing(status="DELIVERED")).json()["items"] == []

    detail = await shop.client.get(
        f"{ADMIN}/{placed[0]['id']}", headers=shop.headers(shop.operator)
    )
    assert detail.status_code == 200
    assert detail.json()["recipient_phone"] == DEMO_PHONE
    error(
        await shop.client.get(f"{ADMIN}/{uuid.uuid4()}", headers=shop.headers(shop.operator)),
        404,
        "order_not_found",
    )


async def test_deleted_product_keeps_the_order_readable(shop: Shop) -> None:
    gone = await shop.product("gone", price=60_000, stock=5)
    await shop.add(gone)
    order = await shop.place()
    async with shop.factory() as session:
        product = await session.get(Product, gone.id)
        assert product is not None
        await session.delete(product)
        await session.commit()
    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["items"][0]["product_id"] is None
    assert detail["items"][0]["sku"] == gone.sku
    # Cancelling still works; there is simply nothing to restock.
    assert (await shop.cancel(order["id"])).status_code == 200


async def test_order_number_is_unique_per_order(shop: Shop) -> None:
    apple = await shop.product("apple", price=60_000, stock=50)
    numbers = set()
    for _ in range(3):
        await shop.add(apple)
        numbers.add((await shop.place())["number"])
    assert len(numbers) == 3
    assert all(ORDER_NUMBER.fullmatch(number) for number in numbers)


# --- rare paths, forced ---------------------------------------------------------------------------


async def test_order_number_collision_is_retried(
    shop: Shop, monkeypatch: pytest.MonkeyPatch
) -> None:
    numbers = iter(["261031-AAAAAA", "261031-AAAAAA", "261031-BBBBBB"])
    monkeypatch.setattr(order_repository, "new_order_number", lambda _now: next(numbers))
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    assert (await shop.place())["number"] == "261031-AAAAAA"
    await shop.add(apple)
    # The second order first draws the taken number; the savepoint is rolled back and retried.
    second = await shop.place()
    assert second["number"] == "261031-BBBBBB"
    assert await shop.count(Order) == 2
    assert await shop.stock(apple) == 3
    assert len(await shop.history(second["id"])) == 1


async def test_lost_idempotency_race_replays_the_winner(
    shop: Shop, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The unique ``(user_id, idempotency_key)`` constraint is the last line of defence: if the
    replay check ever misses a committed order, the insert fails, everything is rolled back and
    the committed order is replayed."""
    apple = await shop.product("apple", price=60_000, stock=5)
    await shop.add(apple)
    key = new_key()
    first = await shop.order(60_000, key=key)
    assert first.status_code == 201
    await shop.add(apple)  # something to order again

    real = order_repository.SqlAlchemyOrderRepository._order_id_for_key
    misses = iter([True])

    async def missing_once(
        self: order_repository.SqlAlchemyOrderRepository, user_id: uuid.UUID, key: str
    ) -> uuid.UUID | None:
        if next(misses, False):
            return None
        return await real(self, user_id, key)

    monkeypatch.setattr(
        order_repository.SqlAlchemyOrderRepository, "_order_id_for_key", missing_once
    )
    replay = await shop.order(60_000, key=key)
    assert replay.status_code == 200, replay.text
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json()["id"] == first.json()["id"]
    # Nothing of the losing attempt survived.
    assert await shop.count(Order) == 1
    assert await shop.count(NotificationOutbox) == 1
    assert await shop.stock(apple) == 4
    assert await shop.count(CartItem) == 1


# --- safety stock (ADR 0018) ----------------------------------------------------------------------


async def test_safety_stock_limits_what_the_storefront_sells(shop: Shop) -> None:
    """3 apples on the shelf, 2 kept back for walk-in shoppers: only 1 can be ordered online."""
    apple = await shop.product("apple", price=10_000, stock=3, safety_stock=2)
    listed = (await shop.client.get("/api/v1/products/apple")).json()
    assert (listed["stock_quantity"], listed["in_stock"], listed["low_stock"]) == (1, True, True)

    response = await shop.client.post(
        ITEMS, json={"product_id": str(apple.id), "quantity": 2}, headers=shop.headers()
    )
    assert error(response, 409, "insufficient_stock")["available_quantity"] == 1
    await shop.add(apple, 1)
    # The kept-back units grow under the cart line: the quote reports it, the order is refused.
    await update_row(shop.factory, Product, apple.id, safety_stock=3)
    quote = (await shop.quote()).json()
    assert quote["items"][0]["issue"] == "insufficient_stock"
    assert quote["items"][0]["product"]["stock_quantity"] == 0
    refused = error(await shop.order(10_000), 409, "insufficient_stock")
    assert refused["available_quantity"] == 0
    assert await shop.stock(apple) == 3

    await update_row(shop.factory, Product, apple.id, safety_stock=2)
    order = await shop.place()
    assert order["total_uzs"] == 10_000
    # The order took the physical stock; the safety stock is left on the shelf.
    assert await shop.stock(apple) == 2
    sold_out = (await shop.client.get("/api/v1/products/apple")).json()
    assert (sold_out["stock_quantity"], sold_out["in_stock"]) == (0, False)
    in_stock_slugs = {
        item["slug"]
        for item in (await shop.client.get("/api/v1/products", params={"in_stock": "true"})).json()[
            "items"
        ]
    }
    assert "apple" not in in_stock_slugs


# --- shortage at picking (ADR 0018) ---------------------------------------------------------------


class Picking:
    def __init__(self, shop: Shop) -> None:
        self.shop = shop

    async def adjust(
        self,
        order_id: str,
        product: Product,
        quantity: int,
        *,
        reason: str = "Javonda qolmadi",
        mark_out_of_stock: bool = False,
        user: UserRecord | None = None,
    ) -> httpx.Response:
        return await self.shop.client.patch(
            f"{ADMIN}/{order_id}/items/{product.id}",
            json={"quantity": quantity, "reason": reason, "mark_out_of_stock": mark_out_of_stock},
            headers=self.shop.headers(user or self.shop.operator),
        )


async def _group(shop: Shop) -> None:
    async with shop.factory() as session:
        if await session.get(StaffNotificationChat, 1) is None:
            session.add(StaffNotificationChat(id=1, chat_id=-1001234567890))
            await session.commit()


async def test_lowering_a_line_returns_stock_and_tells_everyone(shop: Shop) -> None:
    await _group(shop)
    apple = await shop.product("apple", price=15_000, stock=5)
    bread = await shop.product("bread", price=4_000, stock=None)
    await shop.add(apple, 3)
    await shop.add(bread, 2)
    order = await shop.place()
    assert await shop.stock(apple) == 2
    picking = Picking(shop)

    response = await picking.adjust(order["id"], apple, 1, reason="Ikkitasi ezilgan")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["subtotal_uzs"], body["total_uzs"], body["item_count"]) == (23_000, 23_000, 3)
    lines = {line["sku"]: line for line in body["items"]}
    assert lines["DEMO-apple"] | {"product_id": None} == {
        "product_id": None,
        "sku": "DEMO-apple",
        "name_uz": "Demo apple",
        "name_ru": "Демо apple",
        "unit": "piece",
        "unit_price_uzs": 15_000,
        "quantity": 1,
        "line_total_uzs": 15_000,
        "original_quantity": 3,
        "adjusted": True,
    }
    assert (lines["DEMO-bread"]["original_quantity"], lines["DEMO-bread"]["adjusted"]) == (2, False)
    assert body["can_adjust_items"] is True
    [adjustment] = body["adjustments"]
    assert adjustment | {"at": None, "product_id": None} == {
        "product_id": None,
        "sku": "DEMO-apple",
        "name_uz": "Demo apple",
        "name_ru": "Демо apple",
        "unit": "piece",
        "from_quantity": 3,
        "to_quantity": 1,
        "reason": "Ikkitasi ezilgan",
        "marked_out_of_stock": False,
        "actor_role": "operator",
        "at": None,
    }
    assert adjustment["product_id"] == str(apple.id)
    # The two units the line no longer takes are back on sale; the status did not change.
    assert await shop.stock(apple) == 4
    assert body["status"] == "NEW"
    assert [change["status"] for change in body["history"]] == ["NEW"]

    events = [(m.event_type, m.payload) for m in await shop.outbox(order["id"])]
    customer = [payload for kind, payload in events if kind == "order.adjusted"]
    staff = [payload for kind, payload in events if kind == "order.staff_adjusted"]
    assert customer == [
        {
            "order_id": order["id"],
            "order_number": order["number"],
            "status": "NEW",
            "locale": "uz",
            "total_uzs": 23_000,
            "chat_id": shop.user.telegram_user_id,
            "changes": [
                {
                    "name_uz": "Demo apple",
                    "name_ru": "Демо apple",
                    "unit": "piece",
                    "from_quantity": 3,
                    "to_quantity": 1,
                }
            ],
        }
    ]
    assert len(staff) == 1
    assert staff[0]["reason"] == "Ikkitasi ezilgan"
    assert staff[0]["recipient_name"] == "Demo Mijoz"
    assert staff[0]["changes"][0]["marked_out_of_stock"] is False

    # Retrying the same request changes nothing.
    again = await picking.adjust(order["id"], apple, 1, reason="Ikkitasi ezilgan")
    assert again.status_code == 200
    assert len(again.json()["adjustments"]) == 1
    assert await shop.stock(apple) == 4
    assert len(await shop.outbox(order["id"])) == len(events)


async def test_out_of_stock_zeroes_the_product_and_an_untracked_line_returns_nothing(
    shop: Shop,
) -> None:
    apple = await shop.product("apple", price=15_000, stock=5)
    bread = await shop.product("bread", price=4_000, stock=None)
    await shop.add(apple, 1)
    await shop.add(bread, 2)
    order = await shop.place()
    assert await shop.stock(apple) == 4
    picking = Picking(shop)

    response = await picking.adjust(order["id"], apple, 0, mark_out_of_stock=True)
    assert response.status_code == 200, response.text
    assert response.json()["total_uzs"] == 8_000
    # The goods physically ran out: the product is out of stock, nothing went back.
    assert await shop.stock(apple) == 0
    # An untracked line gives nothing back.
    assert (await picking.adjust(order["id"], bread, 1)).status_code == 200
    assert await shop.stock(bread) is None
    detail = await shop.client.get(f"{ADMIN}/{order['id']}", headers=shop.headers(shop.operator))
    assert [a["to_quantity"] for a in detail.json()["adjustments"]] == [0, 1]
    assert detail.json()["status"] == "NEW"


async def test_when_every_line_runs_out_the_order_is_cancelled(shop: Shop) -> None:
    await _group(shop)
    apple = await shop.product("apple", price=15_000, stock=5)
    await shop.add(apple, 2)
    order = await shop.place()
    assert (await shop.move(order["id"], "CONFIRMED")).status_code == 200
    picking = Picking(shop)

    response = await picking.adjust(order["id"], apple, 0)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "CANCELLED"
    assert body["cancel_reason"] == "Mahsulotlar tugab qoldi"
    assert (body["subtotal_uzs"], body["total_uzs"], body["item_count"]) == (0, 0, 0)
    assert body["can_adjust_items"] is False
    # The two units went back once (by the adjustment), not twice.
    assert await shop.stock(apple) == 5
    kinds = [m.event_type for m in await shop.outbox(order["id"])]
    assert "order.adjusted" not in kinds
    assert "order.staff_adjusted" not in kinds
    cancelled = [
        m.payload
        for m in await shop.outbox(order["id"])
        if m.event_type == "order.status_changed" and m.payload["status"] == "CANCELLED"
    ]
    assert cancelled[0]["cancel_reason"] == "Mahsulotlar tugab qoldi"


async def test_adjustment_refusals(shop: Shop) -> None:
    apple = await shop.product("apple", price=15_000, stock=5)
    pear = await shop.product("pear", price=9_000, stock=5)
    await shop.add(apple, 2)
    order = await shop.place()
    picking = Picking(shop)

    assert (
        error(await picking.adjust(order["id"], apple, 3), 409, "invalid_quantity")[
            "available_quantity"
        ]
        == 2
    )
    error(await picking.adjust(order["id"], pear, 0), 404, "order_item_not_found")
    error(await picking.adjust(str(uuid.uuid4()), apple, 0), 404, "order_not_found")
    error(await picking.adjust(order["id"], apple, 1, reason="x"), 422, "validation_error")
    error(await picking.adjust(order["id"], apple, -1), 422, "validation_error")
    # Customers cannot reach the back office.
    assert (await picking.adjust(order["id"], apple, 1, user=shop.user)).status_code == 403

    for status in ("CONFIRMED", "PICKING", "READY_FOR_DELIVERY"):
        assert (await shop.move(order["id"], status)).status_code == 200
    refused = error(await picking.adjust(order["id"], apple, 1), 409, "order_not_adjustable")
    assert refused["current_status"] == "READY_FOR_DELIVERY"
    assert await shop.stock(apple) == 3
    assert await shop.count(OrderItemAdjustment) == 0


async def test_an_adjusted_order_can_be_cancelled_by_the_customer_while_picking(
    shop: Shop,
) -> None:
    apple = await shop.product("apple", price=15_000, stock=5)
    bread = await shop.product("bread", price=4_000, stock=5)
    await shop.add(apple, 2)
    await shop.add(bread, 1)
    order = await shop.place()
    for status in ("CONFIRMED", "PICKING"):
        assert (await shop.move(order["id"], status)).status_code == 200
    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["can_cancel"] is False
    error(await shop.cancel(order["id"]), 409, "order_not_cancellable")

    assert (await Picking(shop).adjust(order["id"], apple, 1)).status_code == 200
    detail = (await shop.client.get(f"{ORDERS}/{order['id']}", headers=shop.headers())).json()
    assert detail["can_cancel"] is True
    assert (await shop.cancel(order["id"], "Kerak emas")).status_code == 200
    # Everything the order still held went back.
    assert (await shop.stock(apple), await shop.stock(bread)) == (5, 5)


async def test_concurrent_adjustments_and_status_changes_serialise(shop: Shop) -> None:
    """An adjustment and a status change racing on one order: both are serialised by the order
    lock, so the adjustment either happens before READY_FOR_DELIVERY or is refused after it."""
    apple = await shop.product("apple", price=15_000, stock=10)
    await shop.add(apple, 4)
    order = await shop.place()
    for status in ("CONFIRMED", "PICKING"):
        assert (await shop.move(order["id"], status)).status_code == 200
    picking = Picking(shop)
    adjust, move = await asyncio.gather(
        picking.adjust(order["id"], apple, 1), shop.move(order["id"], "READY_FOR_DELIVERY")
    )
    assert move.status_code == 200
    assert adjust.status_code in (200, 409)
    expected_stock = 9 if adjust.status_code == 200 else 6
    assert await shop.stock(apple) == expected_stock
    # Two concurrent identical adjustments return the stock once.
    other = await shop.product("other", price=1_000, stock=10)
    await shop.add(other, 5)
    second = await shop.place()
    first, repeat = await asyncio.gather(
        picking.adjust(second["id"], other, 2), picking.adjust(second["id"], other, 2)
    )
    assert (first.status_code, repeat.status_code) == (200, 200)
    assert await shop.stock(other) == 8
