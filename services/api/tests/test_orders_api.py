"""Checkout, order, admin and delivery-zone routes against fake repositories (no database).

Like ``tests/test_cart_api.py``, most tests override ``get_current_user`` / ``require_csrf`` and
the module-level rate-limit dependencies through ``app.dependency_overrides``. The session and
CSRF wiring is additionally checked end to end with a real (in-memory) session.
"""

import dataclasses
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, time
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.exc import IntegrityError

from app.api import admin_deps as admin_routes
from app.api import auth_deps
from app.api.routes import catalog as catalog_routes
from app.api.routes import delivery as delivery_routes
from app.api.routes import orders as order_routes
from app.core.errors import ApiError, log_unhandled_exception
from app.domain.checkout import (
    BelowMinimumOrderError,
    CartEmptyError,
    CheckoutError,
    DistrictNotServedError,
    IdempotencyKeyConflictError,
    InvalidStatusTransitionError,
    OrderInsufficientStockError,
    OrderNotCancellableError,
    OrderNotFoundError,
    OrderProductUnavailableError,
    OrderStatusConflictError,
    PriceChangedError,
    SlotFullError,
    SlotRequiredError,
    SlotUnavailableError,
)
from app.domain.order_status import OrderStatus
from app.models.enums import UserRole
from app.repositories.delivery import SlotOptionRecord, ZoneRecord
from app.repositories.orders import (
    Actor,
    CreatedOrder,
    NewOrder,
    OrderPageRecord,
    OrderRecord,
    OrderSummaryRecord,
    QuoteRecord,
    SlotSnapshotRecord,
)
from app.repositories.users import UserRecord
from app.schemas.checkout import CreateOrderRequest
from tests.auth_helpers import TRUSTED_ORIGIN, build_app, cookie_header, http_client, login
from tests.catalog_factories import make_line, make_product, make_user
from tests.conftest import FakeClock, FakeUserRepository
from tests.order_factories import (
    CREATED_AT,
    DEMO_PHONE,
    make_order,
    make_quote,
    make_zone,
    order_body,
)

QUOTE = "/api/v1/checkout/quote"
ORDERS = "/api/v1/orders"
ADMIN = "/api/v1/admin/orders"
ZONES = "/api/v1/delivery/zones"
KEY = "test-idempotency-key-0001"
ORDER_ID = uuid.uuid4()


class FakeOrderRepository:
    """Records every call; returns canned records or raises ``error``."""

    def __init__(self) -> None:
        self.quote_record: QuoteRecord = make_quote(
            (make_line(make_product(price_uzs=25_000), quantity=2),)
        )
        self.order: OrderRecord = make_order(id=ORDER_ID)
        self.replayed = False
        self.page = OrderPageRecord(items=(), total=0)
        self.error: CheckoutError | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _record(self, name: str, **arguments: Any) -> None:
        self.calls.append((name, arguments))
        if self.error is not None:
            raise self.error

    async def quote(self, user_id: uuid.UUID, district: str, *, now: datetime) -> QuoteRecord:
        self._record("quote", user_id=user_id, district=district, now=now)
        return self.quote_record

    async def create_order(
        self,
        user_id: uuid.UUID,
        new_order: NewOrder,
        *,
        idempotency_key: str,
        request_hash: str,
        now: datetime,
    ) -> CreatedOrder:
        self._record(
            "create",
            user_id=user_id,
            new_order=new_order,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            now=now,
        )
        return CreatedOrder(order=self.order, replayed=self.replayed)

    async def list_for_user(
        self, user_id: uuid.UUID, *, page: int, page_size: int
    ) -> OrderPageRecord:
        self._record("list_for_user", user_id=user_id, page=page, page_size=page_size)
        return self.page

    async def get_for_user(self, user_id: uuid.UUID, order_id: uuid.UUID) -> OrderRecord | None:
        self._record("get_for_user", user_id=user_id, order_id=order_id)
        return self.order if order_id == self.order.id else None

    async def cancel_for_user(
        self, user_id: uuid.UUID, order_id: uuid.UUID, reason: str
    ) -> OrderRecord:
        self._record("cancel_for_user", user_id=user_id, order_id=order_id, reason=reason)
        return self.order

    async def list_all(
        self, *, status: OrderStatus | None, page: int, page_size: int
    ) -> OrderPageRecord:
        self._record("list_all", status=status, page=page, page_size=page_size)
        return self.page

    async def get(self, order_id: uuid.UUID) -> OrderRecord | None:
        self._record("get", order_id=order_id)
        return self.order if order_id == self.order.id else None

    async def change_status(
        self,
        order_id: uuid.UUID,
        target: OrderStatus,
        *,
        actor: Actor,
        reason: str | None,
        expected_status: OrderStatus | None,
    ) -> OrderRecord:
        self._record(
            "change_status",
            order_id=order_id,
            target=target,
            actor=actor,
            reason=reason,
            expected_status=expected_status,
        )
        return self.order

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


class FakeZoneRepository:
    def __init__(self, zones: list[ZoneRecord]) -> None:
        self.zones = zones

    async def list_active(self) -> list[ZoneRecord]:
        return self.zones

    async def find_for_district(self, district: str) -> ZoneRecord | None:  # pragma: no cover
        return next((zone for zone in self.zones if district in zone.districts), None)


async def _allow() -> None:
    return None


def _raiser(error: ApiError) -> Callable[[], Any]:
    async def dependency() -> None:
        raise error

    return dependency


LIMITS = (
    order_routes.ORDERS_IP_LIMIT,
    order_routes.CHECKOUT_QUOTE_LIMIT,
    order_routes.ORDER_CREATE_LIMIT,
    order_routes.ORDER_READ_LIMIT,
    order_routes.ORDER_CANCEL_LIMIT,
    admin_routes.ADMIN_IP_LIMIT,
    admin_routes.ADMIN_READ_LIMIT,
    admin_routes.ADMIN_WRITE_LIMIT,
)


@pytest.fixture
def user() -> UserRecord:
    return make_user()


@pytest.fixture
def orders(app: FastAPI, user: UserRecord) -> FakeOrderRepository:
    repository = FakeOrderRepository()
    app.dependency_overrides[order_routes.get_order_repository] = lambda: repository
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    app.dependency_overrides[auth_deps.require_csrf] = _allow
    app.dependency_overrides[admin_routes.require_back_office_session] = _allow
    for limit in LIMITS:
        app.dependency_overrides[limit] = _allow
    return repository


def as_role(app: FastAPI, role: UserRole) -> UserRecord:
    staff = make_user(role=role)
    app.dependency_overrides[auth_deps.get_current_user] = lambda: staff
    return staff


def create(client: httpx.AsyncClient, body: dict[str, Any] | None = None, key: str = KEY) -> Any:
    payload = order_body() if body is None else body
    return client.post(ORDERS, json=payload, headers={"Idempotency-Key": key})


def error_of(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- quote ----------------------------------------------------------------------------------------


async def test_quote(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord, clock: FakeClock
) -> None:
    response = await client.post(QUOTE, json={"district": "chilonzor"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["subtotal_uzs"] == 50_000
    assert body["delivery_fee_uzs"] == 15_000
    assert body["total_uzs"] == 65_000
    assert body["free_delivery_remaining_uzs"] == 250_000
    assert body["item_count"] == 2
    assert body["issues"] == []
    assert body["can_place_order"] is True
    assert body["zone"]["districts"] == [
        {"code": "chilonzor", "name_uz": "Chilonzor", "name_ru": "Чиланзарский"},
        {"code": "olmazor", "name_uz": "Olmazor", "name_ru": "Алмазарский"},
    ]
    assert body["zone"]["opens_at"] == "09:00"
    assert set(body["items"][0]) == {"product", "quantity", "line_total_uzs", "issue"}
    # A zone without delivery slots.
    assert (body["slot_required"], body["delivery_slots"]) == (False, [])
    assert orders.calls == [
        (
            "quote",
            {
                "user_id": user.id,
                "district": "chilonzor",
                "now": datetime.fromtimestamp(clock.now, tz=UTC),
            },
        )
    ]


async def test_quote_lists_delivery_slots(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    open_slot = SlotOptionRecord(
        id=uuid.uuid4(),
        slot_date=date(2026, 11, 1),
        starts_at=time(10, 0),
        ends_at=time(13, 0),
        capacity=5,
        reserved_count=2,
    )
    full_slot = dataclasses.replace(
        open_slot, id=uuid.uuid4(), starts_at=time(15, 0), ends_at=time(18, 30), reserved_count=5
    )
    orders.quote_record = dataclasses.replace(
        orders.quote_record, slot_required=True, slots=(open_slot, full_slot)
    )
    body = (await client.post(QUOTE, json={"district": "chilonzor"})).json()
    assert body["slot_required"] is True
    assert body["delivery_slots"] == [
        {
            "id": str(open_slot.id),
            "date": "2026-11-01",
            "starts_at": "10:00",
            "ends_at": "13:00",
            "remaining": 3,
            "is_full": False,
        },
        {
            "id": str(full_slot.id),
            "date": "2026-11-01",
            "starts_at": "15:00",
            "ends_at": "18:30",
            "remaining": 0,
            "is_full": True,
        },
    ]


async def test_quote_reports_problems_instead_of_failing(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    orders.quote_record = make_quote(
        (
            make_line(make_product(price_uzs=30_000)),
            make_line(make_product(price_uzs=99_000), is_available=False),
        )
    )
    response = await client.post(QUOTE, json={"district": "chilonzor"})
    assert response.status_code == 200
    body = response.json()
    assert body["issues"] == ["cart_has_issues", "below_min_order"]
    assert body["can_place_order"] is False
    assert [line["issue"] for line in body["items"]] == [None, "product_inactive"]


async def test_quote_zone_open_now_uses_the_app_clock(
    client: httpx.AsyncClient, orders: FakeOrderRepository, clock: FakeClock
) -> None:
    clock.now = datetime(2026, 10, 31, 4, 0, tzinfo=UTC).timestamp()  # 09:00 in Tashkent
    assert (await client.post(QUOTE, json={"district": "chilonzor"})).json()["zone"]["is_open_now"]
    clock.now = datetime(2026, 10, 31, 16, 0, tzinfo=UTC).timestamp()  # 21:00 in Tashkent
    body = (await client.post(QUOTE, json={"district": "chilonzor"})).json()
    assert body["zone"]["is_open_now"] is False


@pytest.mark.parametrize(
    "body", [{"district": "tashkent"}, {}, {"district": "chilonzor", "total_uzs": 1}]
)
async def test_quote_validates_the_district(
    client: httpx.AsyncClient, orders: FakeOrderRepository, body: dict[str, Any]
) -> None:
    error_of(await client.post(QUOTE, json=body), 422, "validation_error")
    assert orders.calls == []


# --- create ---------------------------------------------------------------------------------------


async def test_create_order(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord, clock: FakeClock
) -> None:
    response = await create(
        client,
        order_body(recipient_phone="+998 (00) 123-45-67", comment="  Demo izoh "),
    )
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "idempotent-replayed" not in response.headers
    body = response.json()
    assert body["id"] == str(ORDER_ID)
    assert body["status"] == "NEW"
    assert body["can_cancel"] is True
    assert body["address"]["district_name_uz"] == "Chilonzor"
    assert body["history"] == [{"status": "NEW", "at": "2026-10-31T07:00:00Z"}]

    [(name, call)] = orders.calls
    assert name == "create"
    assert call["user_id"] == user.id
    assert call["idempotency_key"] == KEY
    assert len(call["request_hash"]) == 64
    assert call["now"] == datetime.fromtimestamp(clock.now, tz=UTC)
    new_order: NewOrder = call["new_order"]
    assert new_order.district == "chilonzor"
    assert new_order.recipient_phone == DEMO_PHONE
    assert new_order.comment == "Demo izoh"
    assert new_order.expected_total_uzs == 65_000
    assert new_order.address == {
        "district": "chilonzor",
        "street": "Demo ko'cha",
        "house": "12",
        "apartment": None,
        "entrance": None,
        "floor": None,
        "landmark": None,
    }
    assert new_order.delivery_slot_id is None
    assert body["delivery_slot"] is None


async def test_create_order_with_a_delivery_slot(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    slot_id = uuid.uuid4()
    orders.order = make_order(
        id=ORDER_ID,
        delivery_slot=SlotSnapshotRecord(
            slot_date=date(2026, 11, 2), starts_at=time(9, 30), ends_at=time(12, 0)
        ),
    )
    response = await create(client, order_body(delivery_slot_id=str(slot_id)))
    assert response.status_code == 201, response.text
    assert response.json()["delivery_slot"] == {
        "date": "2026-11-02",
        "starts_at": "09:30",
        "ends_at": "12:00",
    }
    [(_, call)] = orders.calls
    assert call["new_order"].delivery_slot_id == slot_id
    # The same order without a slot is a different request (an idempotency conflict, not a
    # replay), while the hash of a body that never had a slot is unchanged.
    assert call["request_hash"] != order_routes.request_hash(
        CreateOrderRequest.model_validate(order_body())
    )


async def test_create_order_validates_the_slot_id(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    for slot in ("not-a-uuid", 42):
        error_of(await create(client, order_body(delivery_slot_id=slot)), 422, "validation_error")
    assert orders.calls == []


async def test_replay_is_200_with_the_replay_header(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    orders.replayed = True
    response = await create(client)
    assert response.status_code == 200
    assert response.headers["idempotent-replayed"] == "true"
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["id"] == str(ORDER_ID)


async def test_equivalent_bodies_send_the_same_request_hash(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    await create(client)
    await create(
        client,
        {
            **order_body(recipient_phone="+998 00 123 45 67", recipient_name=" Demo Mijoz "),
            "address": {"street": " Demo ko'cha", "house": "12 ", "district": "chilonzor"},
        },
    )
    await create(client, order_body(expected_total_uzs=70_000))
    hashes = [call["request_hash"] for _, call in orders.calls]
    assert hashes[0] == hashes[1]
    assert hashes[2] != hashes[0]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Idempotency-Key": ""},
        {"Idempotency-Key": "short"},
        {"Idempotency-Key": "x" * 129},
        {"Idempotency-Key": "test idempotency key 0002"},
        {"Idempotency-Key": "test;idempotency;key;0003"},
        {"Idempotency-Key": "test.idempotency.key.0004"},
    ],
)
async def test_idempotency_key_is_required_and_validated(
    client: httpx.AsyncClient, orders: FakeOrderRepository, headers: dict[str, str]
) -> None:
    response = await client.post(ORDERS, json=order_body(), headers=headers)
    body = error_of(response, 422, "validation_error")
    assert any(detail["loc"][:2] == ["header", "Idempotency-Key"] for detail in body["details"])
    assert response.headers["cache-control"] == "no-store"
    assert orders.calls == []


@pytest.mark.parametrize("key", ["a" * 16, "A" * 128, KEY, "test_idempotency_key_0005"])
async def test_valid_idempotency_keys(
    client: httpx.AsyncClient, orders: FakeOrderRepository, key: str
) -> None:
    assert (await create(client, key=key)).status_code == 201


@pytest.mark.parametrize(
    "body",
    [
        order_body(total_uzs=1),
        order_body(recipient_phone="998001234567"),
        order_body(address={"district": "tashkent", "street": "Demo ko'cha", "house": "1"}),
        order_body(address={"district": "chilonzor", "street": "Demo\nko'cha", "house": "1"}),
        order_body(expected_total_uzs=-1),
        {},
    ],
)
async def test_create_rejects_invalid_bodies_without_echoing_them(
    client: httpx.AsyncClient, orders: FakeOrderRepository, body: dict[str, Any]
) -> None:
    response = await create(client, body)
    error_of(response, 422, "validation_error")
    assert "998001234567" not in response.text
    assert "Demo" not in response.text
    assert orders.calls == []


# --- domain errors --------------------------------------------------------------------------------

PRODUCT_ID = uuid.uuid4()

CREATE_ERRORS: list[tuple[CheckoutError, int, dict[str, Any]]] = [
    (DistrictNotServedError("bektemir"), 409, {"code": "district_not_served"}),
    (CartEmptyError(), 409, {"code": "cart_empty"}),
    (BelowMinimumOrderError(), 409, {"code": "below_min_order"}),
    (IdempotencyKeyConflictError(), 409, {"code": "idempotency_key_conflict"}),
    (
        OrderProductUnavailableError(PRODUCT_ID),
        409,
        {"code": "product_inactive", "product_id": str(PRODUCT_ID)},
    ),
    (
        OrderInsufficientStockError(PRODUCT_ID, 0),
        409,
        {"code": "insufficient_stock", "product_id": str(PRODUCT_ID), "available_quantity": 0},
    ),
    (PriceChangedError(80_000), 409, {"code": "price_changed", "total_uzs": 80_000}),
    (SlotRequiredError(), 409, {"code": "slot_required"}),
    (SlotUnavailableError(), 409, {"code": "slot_unavailable"}),
    (SlotFullError(), 409, {"code": "slot_full"}),
]


@pytest.mark.parametrize(("error", "status", "expected"), CREATE_ERRORS)
async def test_create_errors(
    client: httpx.AsyncClient,
    orders: FakeOrderRepository,
    error: CheckoutError,
    status: int,
    expected: dict[str, Any],
) -> None:
    orders.error = error
    response = await create(client)
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    body = response.json()["error"]
    assert {key: value for key, value in body.items() if key != "message"} == expected
    assert body["message"]


async def test_quote_district_not_served(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    orders.error = DistrictNotServedError("bektemir")
    response = await client.post(QUOTE, json={"district": "bektemir"})
    assert response.json() == {
        "error": {"code": "district_not_served", "message": "No delivery to this district"}
    }
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("error", "status", "expected"),
    [
        (OrderNotFoundError(), 404, {"code": "order_not_found"}),
        (
            OrderNotCancellableError("PICKING"),
            409,
            {"code": "order_not_cancellable", "current_status": "PICKING"},
        ),
    ],
)
async def test_cancel_errors(
    client: httpx.AsyncClient,
    orders: FakeOrderRepository,
    error: CheckoutError,
    status: int,
    expected: dict[str, Any],
) -> None:
    orders.error = error
    response = await client.post(f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Fikrim o'zgardi"})
    assert response.status_code == status
    body = response.json()["error"]
    assert {key: value for key, value in body.items() if key != "message"} == expected
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            OrderStatusConflictError("CONFIRMED"),
            {"code": "order_status_conflict", "current_status": "CONFIRMED"},
        ),
        (
            InvalidStatusTransitionError("NEW"),
            {"code": "invalid_status_transition", "current_status": "NEW"},
        ),
    ],
)
async def test_admin_status_errors(
    app: FastAPI,
    client: httpx.AsyncClient,
    orders: FakeOrderRepository,
    error: CheckoutError,
    expected: dict[str, Any],
) -> None:
    as_role(app, UserRole.OPERATOR)
    orders.error = error
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/status", json={"status": "PICKING"})
    assert response.status_code == 409
    body = response.json()["error"]
    assert {key: value for key, value in body.items() if key != "message"} == expected
    assert response.headers["cache-control"] == "no-store"


async def test_admin_unknown_order_is_404(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    as_role(app, UserRole.ADMIN)
    error_of(await client.get(f"{ADMIN}/{uuid.uuid4()}"), 404, "order_not_found")
    orders.error = OrderNotFoundError()
    response = await client.patch(f"{ADMIN}/{uuid.uuid4()}/status", json={"status": "CONFIRMED"})
    error_of(response, 404, "order_not_found")


# --- customer reads / cancel ----------------------------------------------------------------------


async def test_list_orders_paginates(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    orders.page = OrderPageRecord(
        items=(
            OrderSummaryRecord(
                id=ORDER_ID,
                number="261031-ABCDEF",
                status=OrderStatus.NEW,
                total_uzs=65_000,
                item_count=2,
                created_at=CREATED_AT,
            ),
        ),
        total=41,
    )
    response = await client.get(ORDERS, params={"page": 2, "page_size": 20})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["page"], body["page_size"], body["total"], body["total_pages"]) == (2, 20, 41, 3)
    assert body["items"][0]["number"] == "261031-ABCDEF"
    assert orders.calls == [("list_for_user", {"user_id": user.id, "page": 2, "page_size": 20})]

    assert (await client.get(ORDERS)).status_code == 200
    assert orders.calls[-1] == ("list_for_user", {"user_id": user.id, "page": 1, "page_size": 20})


@pytest.mark.parametrize(
    "params", [{"page": 0}, {"page_size": 0}, {"page_size": 51}, {"page": 100_001}, {"page": "x"}]
)
async def test_list_orders_bounds(
    client: httpx.AsyncClient, orders: FakeOrderRepository, params: dict[str, Any]
) -> None:
    error_of(await client.get(ORDERS, params=params), 422, "validation_error")
    assert orders.calls == []


async def test_get_order_is_scoped_to_the_user(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    response = await client.get(f"{ORDERS}/{ORDER_ID}")
    assert response.status_code == 200
    assert response.json()["recipient_phone"] == DEMO_PHONE
    other = uuid.uuid4()
    missing = await client.get(f"{ORDERS}/{other}")
    assert missing.json() == {"error": {"code": "order_not_found", "message": "Order not found"}}
    assert missing.headers["cache-control"] == "no-store"
    assert orders.calls == [
        ("get_for_user", {"user_id": user.id, "order_id": ORDER_ID}),
        ("get_for_user", {"user_id": user.id, "order_id": other}),
    ]
    error_of(await client.get(f"{ORDERS}/not-a-uuid"), 422, "validation_error")


async def test_cancel_order(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    orders.order = make_order(OrderStatus.CANCELLED, id=ORDER_ID)
    response = await client.post(
        f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": " Fikrim o'zgardi "}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "CANCELLED"
    assert response.json()["can_cancel"] is False
    assert orders.calls == [
        ("cancel_for_user", {"user_id": user.id, "order_id": ORDER_ID, "reason": "Fikrim o'zgardi"})
    ]


@pytest.mark.parametrize(
    "body", [{}, {"reason": ""}, {"reason": "  a "}, {"reason": "abc", "x": 1}]
)
async def test_cancel_needs_a_reason(
    client: httpx.AsyncClient, orders: FakeOrderRepository, body: dict[str, Any]
) -> None:
    error_of(await client.post(f"{ORDERS}/{ORDER_ID}/cancel", json=body), 422, "validation_error")
    assert orders.calls == []


# --- session, CSRF and rate limits ----------------------------------------------------------------


def _customer_requests(client: httpx.AsyncClient) -> list[Any]:
    return [
        client.post(QUOTE, json={"district": "chilonzor"}),
        create(client),
        client.get(ORDERS),
        client.get(f"{ORDERS}/{ORDER_ID}"),
        client.post(f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Fikrim o'zgardi"}),
    ]


async def test_every_route_requires_a_session(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    app.dependency_overrides[auth_deps.get_current_user] = _raiser(
        ApiError(401, "session_required", "Sign-in required")
    )
    requests = [
        *_customer_requests(client),
        client.get(ADMIN),
        client.get(f"{ADMIN}/{ORDER_ID}"),
        client.patch(f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}),
    ]
    for request in requests:
        response = await request
        error_of(response, 401, "session_required")
        assert response.headers["cache-control"] == "no-store"
    assert orders.calls == []


async def test_writes_require_csrf_but_reads_do_not(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF validation failed")
    )
    assert (await client.get(ORDERS)).status_code == 200
    assert (await client.get(f"{ORDERS}/{ORDER_ID}")).status_code == 200
    for response in (
        await client.post(QUOTE, json={"district": "chilonzor"}),
        await create(client),
        await client.post(f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Fikrim o'zgardi"}),
    ):
        error_of(response, 403, "csrf_failed")
    as_role(app, UserRole.OPERATOR)
    assert (await client.get(ADMIN)).status_code == 200
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"})
    error_of(response, 403, "csrf_failed")
    assert orders.names() == ["list_for_user", "get_for_user", "list_all"]


async def test_each_route_uses_its_own_rate_limit(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    limited = ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "5"})
    routes: list[tuple[Callable[..., Any], Callable[[], Any]]] = [
        (
            order_routes.CHECKOUT_QUOTE_LIMIT,
            lambda: client.post(QUOTE, json={"district": "olmazor"}),
        ),
        (order_routes.ORDER_CREATE_LIMIT, lambda: create(client)),
        (order_routes.ORDER_READ_LIMIT, lambda: client.get(ORDERS)),
        (order_routes.ORDER_READ_LIMIT, lambda: client.get(f"{ORDERS}/{ORDER_ID}")),
        (
            order_routes.ORDER_CANCEL_LIMIT,
            lambda: client.post(f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Demo sabab"}),
        ),
    ]
    for limit, request in routes:
        app.dependency_overrides[limit] = _raiser(limited)
        response = await request()
        error_of(response, 429, "rate_limited")
        assert response.headers["retry-after"] == "5"
        assert response.headers["cache-control"] == "no-store"
        app.dependency_overrides[limit] = _allow
    assert orders.calls == []


async def test_ip_limit_runs_before_the_session_lookup(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    looked_up: list[bool] = []

    async def current_user() -> UserRecord:
        looked_up.append(True)
        raise ApiError(401, "session_required", "Sign-in required")

    app.dependency_overrides[auth_deps.get_current_user] = current_user
    app.dependency_overrides[order_routes.ORDERS_IP_LIMIT] = _raiser(
        ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "3"})
    )
    app.dependency_overrides[admin_routes.ADMIN_IP_LIMIT] = _raiser(
        ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "3"})
    )
    for request in (*_customer_requests(client), client.get(ADMIN)):
        error_of(await request, 429, "rate_limited")
    assert looked_up == []
    assert orders.calls == []


async def test_order_create_limit_is_10_per_minute_per_user(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    del app.dependency_overrides[order_routes.ORDER_CREATE_LIMIT]  # the real in-memory limiter
    for _ in range(10):
        assert (await create(client)).status_code == 201
    error_of(await create(client), 429, "rate_limited")
    as_role(app, UserRole.CUSTOMER)  # another user has their own budget
    assert (await create(client)).status_code == 201


# --- real session + CSRF (no overrides of the auth layer) -----------------------------------------


async def test_real_session_and_csrf_wiring(clock: FakeClock) -> None:
    users = FakeUserRepository()
    app = build_app(clock, users)
    repository = FakeOrderRepository()
    app.dependency_overrides[order_routes.get_order_repository] = lambda: repository
    async with http_client(app) as client:
        # No session at all.
        for request in _customer_requests(client):
            error_of(await request, 401, "session_required")
        signed_in = await login(client, clock)
        session = cookie_header(signed_in.token)
        csrf = {**session, "Origin": TRUSTED_ORIGIN, "X-CSRF-Token": signed_in.csrf_token}

        # Reads need only the session.
        assert (await client.get(ORDERS, headers=session)).status_code == 200
        # Writes need the CSRF token (and a trusted origin when one is sent).
        for headers in (
            session,
            {**session, "X-CSRF-Token": "wrong"},
            {**csrf, "Origin": "https://evil.example"},
        ):
            for response in (
                await client.post(QUOTE, json={"district": "chilonzor"}, headers=headers),
                await client.post(
                    ORDERS, json=order_body(), headers={**headers, "Idempotency-Key": KEY}
                ),
                await client.post(
                    f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Demo sabab"}, headers=headers
                ),
            ):
                error_of(response, 403, "csrf_failed")
                assert response.headers["cache-control"] == "no-store"
        assert repository.names() == ["list_for_user"]

        assert (
            await client.post(QUOTE, json={"district": "chilonzor"}, headers=csrf)
        ).status_code == 200
        response = await client.post(
            ORDERS, json=order_body(), headers={**csrf, "Idempotency-Key": KEY}
        )
        assert response.status_code == 201

        # A customer session cannot reach the back office; the repository is never called.
        before = len(repository.calls)
        error_of(await client.get(ADMIN, headers=session), 403, "forbidden")
        response = await client.patch(
            f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}, headers=csrf
        )
        error_of(response, 403, "forbidden")
        assert len(repository.calls) == before

        # Promote the user: the role is re-read on every request, but a Mini App (initData)
        # session is a storefront session and never a back-office credential.
        [record] = users.users.values()
        users.users[record.telegram_user_id] = dataclasses.replace(record, role=UserRole.OPERATOR)
        error_of(await client.get(ADMIN, headers=session), 403, "forbidden")
        response = await client.patch(
            f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}, headers=csrf
        )
        error_of(response, 403, "forbidden")
        assert len(repository.calls) == before

        # The same operator signed in through the Login Widget (the admin app's sign-in).
        widget = await app.state.session_manager.create(
            user_id=record.id,
            telegram_user_id=record.telegram_user_id,
            auth_method="telegram_login_widget",
        )
        admin_session = cookie_header(widget.token)
        admin_csrf = {
            **admin_session,
            "Origin": TRUSTED_ORIGIN,
            "X-CSRF-Token": widget.data.csrf_token,
        }
        assert (await client.get(ADMIN, headers=admin_session)).status_code == 200
        response = await client.patch(
            f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}, headers=admin_session
        )
        error_of(response, 403, "csrf_failed")
        response = await client.patch(
            f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}, headers=admin_csrf
        )
        assert response.status_code == 200


# --- admin ----------------------------------------------------------------------------------------


async def test_customers_cannot_use_the_back_office(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    for response in (
        await client.get(ADMIN),
        await client.get(ADMIN, params={"status": "NEW"}),
        await client.get(f"{ADMIN}/{ORDER_ID}"),
        await client.patch(f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"}),
    ):
        assert response.json() == {
            "error": {"code": "forbidden", "message": "Operator role required"}
        }
        assert response.status_code == 403
        assert response.headers["cache-control"] == "no-store"
    assert orders.calls == []


@pytest.mark.parametrize("role", [UserRole.OPERATOR, UserRole.ADMIN])
async def test_staff_can_use_the_back_office(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository, role: UserRole
) -> None:
    staff = as_role(app, role)
    response = await client.get(ADMIN, params={"status": "NEW", "page": 3, "page_size": 5})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert orders.calls[-1] == ("list_all", {"status": OrderStatus.NEW, "page": 3, "page_size": 5})
    await client.get(ADMIN)
    assert orders.calls[-1] == ("list_all", {"status": None, "page": 1, "page_size": 20})

    detail = await client.get(f"{ADMIN}/{ORDER_ID}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["allowed_transitions"] == ["CONFIRMED", "CANCELLED"]
    assert body["history_detail"][0]["actor_role"] == "customer"
    assert body["recipient_phone"] == DEMO_PHONE

    response = await client.patch(
        f"{ADMIN}/{ORDER_ID}/status",
        json={"status": "CANCELLED", "reason": " Mijoz rad etdi ", "expected_status": "NEW"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert orders.calls[-1] == (
        "change_status",
        {
            "order_id": ORDER_ID,
            "target": OrderStatus.CANCELLED,
            "actor": Actor(user_id=staff.id, role=role),
            "reason": "Mijoz rad etdi",
            "expected_status": OrderStatus.NEW,
        },
    )


@pytest.mark.parametrize(
    "body",
    [
        {"status": "SHIPPED"},
        {"status": "CANCELLED", "reason": "  "},
        {"status": "CONFIRMED", "expected_status": "LOST"},
        {"status": "CONFIRMED", "extra": 1},
        {},
    ],
)
async def test_admin_status_body_validation(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository, body: dict[str, Any]
) -> None:
    as_role(app, UserRole.OPERATOR)
    error_of(await client.patch(f"{ADMIN}/{ORDER_ID}/status", json=body), 422, "validation_error")
    error_of(await client.get(ADMIN, params={"status": "LOST"}), 422, "validation_error")
    assert orders.calls == []


# --- delivery zones (public) ----------------------------------------------------------------------


async def test_delivery_zones_are_public_and_cached(
    app: FastAPI, client: httpx.AsyncClient, clock: FakeClock
) -> None:
    zones = [
        make_zone(slug="demo-a", districts=frozenset({"yunusobod", "mirobod"})),
        make_zone(
            slug="demo-b",
            districts=frozenset({"sergeli"}),
            free_delivery_threshold_uzs=None,
            opens_at=time(10, 0),
        ),
    ]
    app.dependency_overrides[delivery_routes.get_delivery_zone_repository] = lambda: (
        FakeZoneRepository(zones)
    )
    clock.now = datetime(2026, 10, 31, 4, 30, tzinfo=UTC).timestamp()  # 09:30 in Tashkent
    response = await client.get(ZONES)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"
    assert "set-cookie" not in response.headers
    body = response.json()
    assert body["timezone"] == "Asia/Tashkent"
    assert [zone["slug"] for zone in body["items"]] == ["demo-a", "demo-b"]
    first, second = body["items"]
    # Districts come in the documented, stable order.
    assert [district["code"] for district in first["districts"]] == ["mirobod", "yunusobod"]
    assert (first["is_open_now"], second["is_open_now"]) == (True, False)
    assert second["free_delivery_threshold_uzs"] is None
    assert second["opens_at"] == "10:00"


async def test_delivery_zones_rate_limit_is_not_cached(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    app.dependency_overrides[catalog_routes.CATALOG_IP_LIMIT] = _raiser(
        ApiError(
            429,
            "rate_limited",
            "Too many requests",
            headers={"Retry-After": "9", "Cache-Control": "no-store"},
        )
    )
    response = await client.get(ZONES)
    error_of(response, 429, "rate_limited")
    assert response.headers["cache-control"] == "no-store"


# --- OpenAPI --------------------------------------------------------------------------------------


async def test_openapi_documents_checkout(client: httpx.AsyncClient) -> None:
    spec = (await client.get("/api/v1/openapi.json")).json()
    paths = spec["paths"]
    create_op = paths["/api/v1/orders"]["post"]
    assert {"200", "201", "409", "422"} <= set(create_op["responses"])
    header = next(p for p in create_op["parameters"] if p["name"] == "Idempotency-Key")
    assert header["in"] == "header"
    assert header["required"] is True
    assert "/api/v1/admin/orders/{order_id}/status" in paths
    assert "/api/v1/delivery/zones" in paths
    error_body = spec["components"]["schemas"]["ApiErrorBody"]["properties"]
    assert {"product_id", "total_uzs", "current_status", "available_quantity"} <= set(error_body)


# --- logging --------------------------------------------------------------------------------------


def test_database_errors_are_logged_without_row_data(caplog: pytest.LogCaptureFixture) -> None:
    """PostgreSQL puts the failing row (recipient, phone, address) into the error message."""

    class FakeUniqueViolationError(Exception):
        sqlstate = "23505"
        constraint_name = "uq_demo"

    secret_row = "Failing row contains (Demo Mijoz, +998000000000, Demo ko'cha 1)"
    error = IntegrityError(
        "INSERT INTO orders ...", {"phone": "+998000000000"}, FakeUniqueViolationError(secret_row)
    )
    try:
        raise error
    except IntegrityError as exc:
        log_unhandled_exception("POST", "/api/v1/orders", exc)
    [record] = caplog.records
    text = record.getMessage() + (record.exc_text or "")
    assert "FakeUniqueViolationError" in text
    assert "uq_demo" in text
    assert "23505" in text
    for leaked in ("Demo Mijoz", "+998000000000", "Demo ko'cha", "INSERT"):
        assert leaked not in text
    assert record.exc_info is None
