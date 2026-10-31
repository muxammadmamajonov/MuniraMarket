"""Delivery slots at checkout against a real PostgreSQL schema built by the Alembic migrations.

Covers the quote's slot list, the booking rules (required, unavailable, full), that concurrent
orders can never overbook a slot (also while an admin lowers its capacity), that cancelling gives
the place back exactly once, the order's slot snapshot, user isolation, and the
``order.status_change`` audit rows (which must never carry the reason text or recipient data).
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import delete, func, select, update

from app.audit import AuditEntity
from app.models.audit import AuditLog
from app.models.cart import CartItem
from app.models.catalog import Product
from app.models.delivery import DeliverySlot, DeliveryZone
from app.models.enums import UserRole
from app.models.order import Order
from app.repositories.users import UserRecord
from tests.conftest import FakeClock
from tests.db_data import (
    TEST_USER_HEADER,
    SessionFactory,
    add_category,
    add_product,
    add_slot,
    add_user,
    add_zone,
    audit_rows,
    build_app,
    slot_state,
)
from tests.db_support import INTEGRATION_MARKS
from tests.order_factories import DEMO_PHONE, order_body

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

QUOTE = "/api/v1/checkout/quote"
ORDERS = "/api/v1/orders"
ADMIN_ORDERS = "/api/v1/admin/orders"
ADMIN_SLOTS = "/api/v1/admin/delivery/slots"
ITEMS = "/api/v1/cart/items"
CROWD = 10
# 2026-11-01 10:00 in Tashkent (UTC+5).
NOW = datetime(2026, 11, 1, 5, 0, tzinfo=UTC)
TODAY = date(2026, 11, 1)
TOMORROW = date(2026, 11, 2)
# A 60 000 product plus the zone's 15 000 delivery fee.
TOTAL = 75_000
# Obviously fake, but shaped like the personal data that must never reach the audit log.
PII_REASON = f"Demo Mijoz {DEMO_PHONE} Demo ko'cha 12 dedi"


class Store:
    def __init__(  # noqa: PLR0917 - a plain holder of fixture data
        self,
        client: httpx.AsyncClient,
        factory: SessionFactory,
        users: list[UserRecord],
        product: Product,
        zone: DeliveryZone,
        plain_zone: DeliveryZone,
        clock: FakeClock,
    ) -> None:
        self.client = client
        self.factory = factory
        self.user, self.other_user, self.operator, self.admin, *self.crowd = users
        self.product = product
        self.zone = zone
        self.plain_zone = plain_zone
        self.clock = clock

    def headers(self, user: UserRecord | None = None, **extra: str) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.user).id), **extra}

    async def fill_cart(self, user: UserRecord | None = None) -> None:
        response = await self.client.post(
            ITEMS,
            json={"product_id": str(self.product.id), "quantity": 1},
            headers=self.headers(user),
        )
        assert response.status_code == 200, response.text

    async def quote(self, district: str = "chilonzor", user: UserRecord | None = None) -> Any:
        response = await self.client.post(
            QUOTE, json={"district": district}, headers=self.headers(user)
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def order(
        self,
        slot: DeliverySlot | uuid.UUID | None,
        *,
        user: UserRecord | None = None,
        key: str | None = None,
        **overrides: Any,
    ) -> httpx.Response:
        body = order_body(expected_total_uzs=TOTAL, **overrides)
        if slot is not None:
            body["delivery_slot_id"] = str(slot if isinstance(slot, uuid.UUID) else slot.id)
        return await self.client.post(
            ORDERS,
            json=body,
            headers=self.headers(user, **{"Idempotency-Key": key or str(uuid.uuid4())}),
        )

    async def cancel(self, order_id: str, user: UserRecord | None = None) -> httpx.Response:
        return await self.client.post(
            f"{ORDERS}/{order_id}/cancel", json={"reason": PII_REASON}, headers=self.headers(user)
        )

    async def move(self, order_id: str, status: str, **fields: Any) -> httpx.Response:
        return await self.client.patch(
            f"{ADMIN_ORDERS}/{order_id}/status",
            json={"status": status, **fields},
            headers=self.headers(self.operator),
        )

    async def count(self, model: type[Any], *where: Any) -> int:
        async with self.factory() as session:
            return (
                await session.execute(select(func.count()).select_from(model).where(*where))
            ).scalar_one()


@pytest_asyncio.fixture(loop_scope="module")
async def store(session_factory: SessionFactory) -> AsyncIterator[Store]:
    users = [
        await add_user(session_factory),
        await add_user(session_factory),
        await add_user(session_factory, role=UserRole.OPERATOR),
        await add_user(session_factory, role=UserRole.ADMIN),
    ]
    users += [await add_user(session_factory) for _ in range(CROWD)]
    category = await add_category(session_factory, "slots-cat")
    product = await add_product(session_factory, category, "slot-apple", price=60_000)
    zone = await add_zone(session_factory, "demo-slots", ["chilonzor", "olmazor"])
    plain = await add_zone(session_factory, "demo-plain", ["yunusobod"])
    clock = FakeClock(NOW.timestamp())
    app = build_app(session_factory, users, clock=clock)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Store(client, session_factory, users, product, zone, plain, clock)


def error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- quote ----------------------------------------------------------------------------------------


async def test_quote_offers_the_bookable_slots(store: Store) -> None:
    await store.fill_cart()
    factory, zone = store.factory, store.zone
    later = await add_slot(factory, zone, TOMORROW, starts_at=time(15, 0), ends_at=time(18, 0))
    early = await add_slot(factory, zone, TOMORROW, capacity=2, reserved_count=2)
    today = await add_slot(factory, zone, TODAY, starts_at=time(14, 0), ends_at=time(16, 0))
    # Not offered: inactive, cutoff passed, beyond the 14-day window, another zone's.
    await add_slot(
        factory, zone, TOMORROW, starts_at=time(19, 0), ends_at=time(20, 0), is_active=False
    )
    await add_slot(factory, zone, TODAY, starts_at=time(11, 0), ends_at=time(12, 0))  # cutoff 09:00
    await add_slot(factory, zone, TODAY + timedelta(days=14))
    await add_slot(factory, store.plain_zone, TOMORROW, cutoff_at=NOW - timedelta(minutes=1))

    body = await store.quote()
    assert body["slot_required"] is True
    assert [slot["id"] for slot in body["delivery_slots"]] == [
        str(today.id),
        str(early.id),
        str(later.id),
    ]
    assert body["delivery_slots"][1] == {
        "id": str(early.id),
        "date": "2026-11-02",
        "starts_at": "10:00",
        "ends_at": "13:00",
        "remaining": 0,
        "is_full": True,
    }
    assert body["delivery_slots"][0]["remaining"] == 10
    assert body["can_place_order"] is True

    # The other zone only has a slot whose cutoff has passed: no slot needed there.
    plain = await store.quote("yunusobod")
    assert (plain["slot_required"], plain["delivery_slots"]) == (False, [])


async def test_slot_required_when_the_zone_has_slots(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW)
    await store.fill_cart()
    error(await store.order(None), 409, "slot_required")
    # Nothing was written: the cart is kept and no place was taken.
    assert await store.count(Order) == 0
    assert await store.count(CartItem) == 1
    assert await slot_state(store.factory, slot.id) == (0, 10)

    # A zone without slots keeps the phase 3 flow.
    plain = await store.order(
        None, address={"district": "yunusobod", "street": "Demo ko'cha", "house": "1"}
    )
    assert plain.status_code == 201, plain.text
    assert plain.json()["delivery_slot"] is None


async def test_booking_a_slot_snapshots_it_and_replays_do_not_book_again(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW, starts_at=time(9, 30))
    await store.fill_cart()
    key = str(uuid.uuid4())
    first = await store.order(slot, key=key)
    assert first.status_code == 201, first.text
    order = first.json()
    assert order["delivery_slot"] == {
        "date": "2026-11-02",
        "starts_at": "09:30",
        "ends_at": "13:00",
    }
    assert await slot_state(store.factory, slot.id) == (1, 10)

    replay = await store.order(slot, key=key)
    assert replay.status_code == 200, replay.text
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json() == order
    # Replays never touch the slot (sequentially or concurrently).
    replays = await asyncio.gather(*(store.order(slot, key=key) for _ in range(4)))
    assert {response.status_code for response in replays} == {200}
    assert await slot_state(store.factory, slot.id) == (1, 10)
    # The same key with a different slot is a different request.
    other = await add_slot(
        store.factory, store.zone, TOMORROW, starts_at=time(15, 0), ends_at=time(16, 0)
    )
    error(await store.order(other, key=key), 409, "idempotency_key_conflict")
    assert await slot_state(store.factory, other.id) == (0, 10)

    async with store.factory() as session:
        stored = await session.get(Order, uuid.UUID(order["id"]))
    assert stored is not None
    assert stored.delivery_slot_id == slot.id
    assert (
        stored.delivery_slot_date,
        stored.delivery_slot_starts_at,
        stored.delivery_slot_ends_at,
    ) == (
        TOMORROW,
        time(9, 30),
        time(13, 0),
    )
    # The snapshot survives a later edit of the slot.
    async with store.factory() as session:
        await session.execute(
            update(DeliverySlot).where(DeliverySlot.id == slot.id).values(ends_at=time(14, 0))
        )
        await session.commit()
    detail = await store.client.get(f"{ORDERS}/{order['id']}", headers=store.headers())
    assert detail.json()["delivery_slot"]["ends_at"] == "13:00"
    admin = await store.client.get(
        f"{ADMIN_ORDERS}/{order['id']}", headers=store.headers(store.operator)
    )
    assert admin.json()["delivery_slot"] == order["delivery_slot"]


async def test_unavailable_slots_are_refused(store: Store) -> None:
    factory, zone = store.factory, store.zone
    bookable = await add_slot(factory, zone, TOMORROW)  # so the zone requires a slot
    past_cutoff = await add_slot(
        factory, zone, TOMORROW, starts_at=time(15, 0), ends_at=time(16, 0), cutoff_at=NOW
    )
    inactive = await add_slot(
        factory, zone, TOMORROW, starts_at=time(16, 0), ends_at=time(17, 0), is_active=False
    )
    elsewhere = await add_slot(factory, store.plain_zone, TOMORROW)
    await store.fill_cart()
    for slot in (past_cutoff, inactive, elsewhere, uuid.uuid4()):
        error(await store.order(slot), 409, "slot_unavailable")
    assert await store.count(Order) == 0
    for slot in (bookable, past_cutoff, inactive, elsewhere):
        assert (await slot_state(factory, slot.id))[0] == 0

    # The cutoff (03:00Z: two hours before 10:00 local) is exclusive and follows the app clock.
    store.clock.now = (NOW + timedelta(hours=22)).timestamp()
    try:
        error(await store.order(bookable), 409, "slot_unavailable")
    finally:
        store.clock.now = NOW.timestamp()
    assert (await store.order(bookable)).status_code == 201


async def test_slots_beyond_the_offer_window_are_neither_required_nor_bookable(
    store: Store,
) -> None:
    """Regression: a zone whose only slots lie beyond the 14 local days the quote offers used to
    answer ``slot_required: true`` with an empty list, a checkout dead end."""
    factory, zone = store.factory, store.zone
    last_day = TODAY + timedelta(days=13)
    far = await add_slot(factory, zone, TODAY + timedelta(days=14))
    farther = await add_slot(factory, zone, TODAY + timedelta(days=40))
    await store.fill_cart()

    body = await store.quote()
    assert (body["slot_required"], body["delivery_slots"]) == (False, [])
    for slot in (far, farther):
        error(await store.order(slot), 409, "slot_unavailable")
        assert (await slot_state(factory, slot.id))[0] == 0
    assert await store.count(Order) == 0

    # The last day of the window is offered, required and bookable.
    edge = await add_slot(factory, zone, last_day)
    body = await store.quote()
    assert body["slot_required"] is True
    assert [slot["id"] for slot in body["delivery_slots"]] == [str(edge.id)]
    error(await store.order(None), 409, "slot_required")
    error(await store.order(far), 409, "slot_unavailable")
    assert (await store.order(edge)).status_code == 201
    assert (await slot_state(factory, edge.id))[0] == 1

    # Without any slot in the window the zone works without slots again.
    async with factory() as session:
        await session.execute(
            update(DeliverySlot).where(DeliverySlot.id == edge.id).values(is_active=False)
        )
        await session.commit()
    await store.fill_cart()
    assert (await store.order(None)).status_code == 201


async def test_a_full_slot_is_refused(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW, capacity=1, reserved_count=1)
    await store.fill_cart()
    error(await store.order(slot), 409, "slot_full")
    zero = await add_slot(
        store.factory, store.zone, TOMORROW, starts_at=time(15, 0), ends_at=time(16, 0), capacity=0
    )
    error(await store.order(zero), 409, "slot_full")
    assert await store.count(Order) == 0
    assert await slot_state(store.factory, slot.id) == (1, 1)


# --- races ----------------------------------------------------------------------------------------


async def test_concurrent_orders_never_overbook_a_slot(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW, capacity=3)
    assert len(store.crowd) == CROWD
    for buyer in store.crowd:
        await store.fill_cart(buyer)

    responses = await asyncio.gather(*(store.order(slot, user=buyer) for buyer in store.crowd))
    created = [response for response in responses if response.status_code == 201]
    refused = [response for response in responses if response.status_code != 201]
    assert len(created) == 3, [response.text for response in responses]
    assert len(refused) == CROWD - 3
    for response in refused:
        error(response, 409, "slot_full")
    assert await slot_state(store.factory, slot.id) == (3, 3)
    assert await store.count(Order, Order.delivery_slot_id == slot.id) == 3
    # The refused customers keep their carts.
    assert await store.count(CartItem) == CROWD - 3


async def test_an_order_and_a_capacity_cut_serialise_on_the_slot(store: Store) -> None:
    """Orders and an admin lowering the capacity race on the same row: whatever the order,
    the slot never holds more bookings than its capacity."""
    for round_ in range(3):
        slot = await add_slot(
            store.factory, store.zone, TOMORROW + timedelta(days=round_), capacity=5
        )
        buyers = store.crowd[:4]
        for buyer in buyers:
            await store.fill_cart(buyer)
        cut = store.client.patch(
            f"{ADMIN_SLOTS}/{slot.id}", json={"capacity": 2}, headers=store.headers(store.admin)
        )
        *orders, admin = await asyncio.gather(
            *(store.order(slot, user=buyer) for buyer in buyers), cut
        )
        created = sum(response.status_code == 201 for response in orders)
        reserved, capacity = await slot_state(store.factory, slot.id)
        assert reserved == created
        assert reserved <= capacity
        if admin.status_code == 200:
            assert capacity == 2
            assert created <= 2
            assert all(
                response.status_code == 201 or response.json()["error"]["code"] == "slot_full"
                for response in orders
            )
        else:
            error(admin, 409, "capacity_below_reserved")
            assert (capacity, created) == (5, 4)
        # Leave the next round a clean slate (refused buyers still hold their carts).
        async with store.factory() as session:
            await session.execute(delete(CartItem))
            await session.commit()


# --- cancellation gives the place back ------------------------------------------------------------


async def test_customer_and_operator_cancels_release_the_place_once(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW, capacity=2)
    await store.fill_cart(store.user)
    mine = (await store.order(slot)).json()
    await store.fill_cart(store.other_user)
    theirs = (await store.order(slot, user=store.other_user)).json()
    assert await slot_state(store.factory, slot.id) == (2, 2)

    # Full: a third customer is refused...
    await store.fill_cart(store.crowd[0])
    error(await store.order(slot, user=store.crowd[0]), 409, "slot_full")

    # ...until the customer cancels: one place comes back, exactly once.
    assert (await store.cancel(mine["id"])).status_code == 200
    assert await slot_state(store.factory, slot.id) == (1, 2)
    error(await store.cancel(mine["id"]), 409, "order_not_cancellable")
    assert await slot_state(store.factory, slot.id) == (1, 2)
    assert (await store.order(slot, user=store.crowd[0])).status_code == 201
    assert await slot_state(store.factory, slot.id) == (2, 2)

    # The operator cancels another one (with a reason): the place comes back too.
    response = await store.move(theirs["id"], "CANCELLED", reason=PII_REASON)
    assert response.status_code == 200, response.text
    assert await slot_state(store.factory, slot.id) == (1, 2)
    error(
        await store.move(theirs["id"], "CANCELLED", reason="Yana"), 409, "invalid_status_transition"
    )
    assert await slot_state(store.factory, slot.id) == (1, 2)


async def test_concurrent_cancels_release_the_place_once(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW)
    await store.fill_cart()
    order = (await store.order(slot)).json()
    responses = await asyncio.gather(
        store.cancel(order["id"]),
        store.cancel(order["id"]),
        store.move(order["id"], "CANCELLED", reason="Operator bekor qildi"),
    )
    assert sorted(response.status_code for response in responses) == [200, 409, 409]
    assert await slot_state(store.factory, slot.id) == (0, 10)


async def test_release_never_goes_below_zero(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW)
    await store.fill_cart()
    order = (await store.order(slot)).json()
    # Someone (an earlier bug, a manual fix) already set the count back to zero.
    async with store.factory() as session:
        await session.execute(
            update(DeliverySlot).where(DeliverySlot.id == slot.id).values(reserved_count=0)
        )
        await session.commit()
    assert (await store.cancel(order["id"])).status_code == 200
    assert await slot_state(store.factory, slot.id) == (0, 10)


# --- isolation ------------------------------------------------------------------------------------


async def test_other_customers_cannot_read_or_cancel_a_booked_order(store: Store) -> None:
    slot = await add_slot(store.factory, store.zone, TOMORROW)
    await store.fill_cart()
    order = (await store.order(slot)).json()
    stranger = store.other_user

    response = await store.client.get(f"{ORDERS}/{order['id']}", headers=store.headers(stranger))
    assert response.json() == {"error": {"code": "order_not_found", "message": "Order not found"}}
    assert response.status_code == 404
    error(await store.cancel(order["id"], user=stranger), 404, "order_not_found")
    listing = await store.client.get(ORDERS, headers=store.headers(stranger))
    assert listing.json()["items"] == []
    error(
        await store.client.get(f"{ADMIN_ORDERS}/{order['id']}", headers=store.headers(stranger)),
        403,
        "forbidden",
    )
    # Untouched: still booked, still NEW.
    assert await slot_state(store.factory, slot.id) == (1, 10)
    detail = await store.client.get(f"{ORDERS}/{order['id']}", headers=store.headers())
    assert detail.json()["status"] == "NEW"


# --- audit ----------------------------------------------------------------------------------------


async def test_status_changes_are_audited_without_personal_data(store: Store) -> None:
    await store.fill_cart()
    first = (
        await store.order(
            None, address={"district": "yunusobod", "street": "Demo ko'cha", "house": "12"}
        )
    ).json()
    assert await audit_rows(store.factory) == []  # placing an order is not a back-office change

    assert (await store.move(first["id"], "CONFIRMED", expected_status="NEW")).status_code == 200
    assert (await store.move(first["id"], "CANCELLED", reason=PII_REASON)).status_code == 200
    await store.fill_cart()
    second = (
        await store.order(
            None, address={"district": "yunusobod", "street": "Demo ko'cha", "house": "12"}
        )
    ).json()
    assert (await store.cancel(second["id"])).status_code == 200

    rows = await audit_rows(store.factory, AuditLog.entity_type == AuditEntity.ORDER)
    assert [(row.action, row.actor_role, row.entity_id) for row in rows] == [
        ("order.status_change", UserRole.OPERATOR, first["id"]),
        ("order.status_change", UserRole.OPERATOR, first["id"]),
        ("order.status_change", UserRole.CUSTOMER, second["id"]),
    ]
    assert [row.actor_user_id for row in rows] == [
        store.operator.id,
        store.operator.id,
        store.user.id,
    ]
    assert rows[0].details == {
        "changes": {"status": {"from": "NEW", "to": "CONFIRMED"}},
        "order_number": first["number"],
        "has_reason": False,
    }
    assert rows[1].details == {
        "changes": {"status": {"from": "CONFIRMED", "to": "CANCELLED"}},
        "order_number": first["number"],
        "has_reason": True,
    }
    assert rows[2].details["has_reason"] is True
    serialized = " ".join(str(row.details) for row in rows)
    for personal in ("Demo Mijoz", DEMO_PHONE, "001234567", "Demo ko'cha", "yunusobod", "dedi"):
        assert personal not in serialized

    # A refused change writes nothing.
    error(await store.move(first["id"], "CONFIRMED"), 409, "invalid_status_transition")
    assert len(await audit_rows(store.factory)) == 3
