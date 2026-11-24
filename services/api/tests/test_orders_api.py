"""Checkout, order and admin order routes against fake repositories (no database).

Like ``tests/test_cart_api.py``, most tests override ``get_current_user`` / ``require_csrf`` and
the module-level rate-limit dependencies through ``app.dependency_overrides``. The session and
CSRF wiring is additionally checked end to end with a real (in-memory) session.
"""

import dataclasses
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.exc import IntegrityError

from app.api import admin_deps as admin_routes
from app.api import auth_deps
from app.api.routes import orders as order_routes
from app.core.errors import ApiError, log_unhandled_exception
from app.domain.checkout import (
    CartEmptyError,
    CheckoutError,
    IdempotencyKeyConflictError,
    InvalidQuantityError,
    InvalidStatusTransitionError,
    OrderInsufficientStockError,
    OrderItemNotFoundError,
    OrderNotAdjustableError,
    OrderNotCancellableError,
    OrderNotFoundError,
    OrderProductUnavailableError,
    OrderStatusConflictError,
    PriceChangedError,
)
from app.domain.order_status import OrderStatus, OrderStatusGroup
from app.models.enums import UserRole
from app.repositories.orders import (
    Actor,
    CreatedOrder,
    NewOrder,
    OrderPageRecord,
    OrderRecord,
    OrderSummaryRecord,
    OrderThumbnailRecord,
    QuoteRecord,
)
from app.repositories.users import UserRecord
from tests.auth_helpers import TRUSTED_ORIGIN, build_app, cookie_header, http_client, login
from tests.catalog_factories import make_line, make_product, make_user
from tests.conftest import FakeClock, FakeUserRepository
from tests.order_factories import (
    CREATED_AT,
    DEMO_PHONE,
    make_order,
    make_quote,
    order_body,
)

QUOTE = "/api/v1/checkout/quote"
ORDERS = "/api/v1/orders"
ADMIN = "/api/v1/admin/orders"
KEY = "test-idempotency-key-0001"
ORDER_ID = uuid.uuid4()
PRODUCT_ID = uuid.uuid4()
ADJUST_BODY: dict[str, Any] = {"quantity": 0, "reason": "Javonda qolmadi"}


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

    async def quote(self, user_id: uuid.UUID) -> QuoteRecord:
        self._record("quote", user_id=user_id)
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
        self,
        user_id: uuid.UUID,
        *,
        page: int,
        page_size: int,
        status_group: OrderStatusGroup = OrderStatusGroup.ALL,
    ) -> OrderPageRecord:
        self._record(
            "list_for_user",
            user_id=user_id,
            page=page,
            page_size=page_size,
            status_group=status_group,
        )
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

    async def adjust_item(
        self,
        order_id: uuid.UUID,
        product_id: uuid.UUID,
        *,
        quantity: int,
        reason: str,
        mark_out_of_stock: bool,
        actor: Actor,
    ) -> OrderRecord:
        self._record(
            "adjust_item",
            order_id=order_id,
            product_id=product_id,
            quantity=quantity,
            reason=reason,
            mark_out_of_stock=mark_out_of_stock,
            actor=actor,
        )
        return self.order

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


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
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    response = await client.post(QUOTE)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {
        "items",
        "item_count",
        "subtotal_uzs",
        "total_uzs",
        "issues",
        "can_place_order",
    }
    assert body["subtotal_uzs"] == 50_000
    # No delivery charge: the customer pays the Yandex Go courier directly.
    assert body["total_uzs"] == 50_000
    assert body["item_count"] == 2
    assert body["issues"] == []
    assert body["can_place_order"] is True
    assert set(body["items"][0]) == {"product", "quantity", "line_total_uzs", "issue"}
    assert orders.calls == [("quote", {"user_id": user.id})]


async def test_quote_ignores_a_request_body(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    # The quote has no request body; anything an old client still sends is not read.
    response = await client.post(QUOTE, json={"region": "chilonzor"})
    assert response.status_code == 200, response.text
    assert orders.calls == [("quote", {"user_id": user.id})]


async def test_quote_reports_problems_instead_of_failing(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    orders.quote_record = make_quote(
        (
            make_line(make_product(price_uzs=30_000)),
            make_line(make_product(price_uzs=99_000), is_available=False),
        )
    )
    response = await client.post(QUOTE)
    assert response.status_code == 200
    body = response.json()
    assert body["issues"] == ["cart_has_issues"]
    assert body["can_place_order"] is False
    assert (body["subtotal_uzs"], body["total_uzs"]) == (30_000, 30_000)
    assert [line["issue"] for line in body["items"]] == [None, "product_inactive"]


async def test_quote_of_an_empty_cart(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    orders.quote_record = make_quote(())
    body = (await client.post(QUOTE)).json()
    assert body["issues"] == ["cart_empty"]
    assert (body["subtotal_uzs"], body["total_uzs"], body["can_place_order"]) == (0, 0, False)


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
    assert body["address"]["lat"] == 41.311081
    assert body["address"]["lon"] == 69.240562
    assert set(body) == {
        "id",
        "number",
        "status",
        "created_at",
        "updated_at",
        "subtotal_uzs",
        "total_uzs",
        "item_count",
        "payment_method",
        "recipient_name",
        "recipient_phone",
        "address",
        "comment",
        "cancel_reason",
        "items",
        "history",
        "can_cancel",
    }
    assert body["subtotal_uzs"] == body["total_uzs"] == 50_000
    assert body["history"] == [{"status": "NEW", "at": "2026-10-31T07:00:00Z"}]

    [(name, call)] = orders.calls
    assert name == "create"
    assert call["user_id"] == user.id
    assert call["idempotency_key"] == KEY
    assert len(call["request_hash"]) == 64
    assert call["now"] == datetime.fromtimestamp(clock.now, tz=UTC)
    new_order: NewOrder = call["new_order"]
    assert new_order.recipient_phone == DEMO_PHONE
    assert new_order.comment == "Demo izoh"
    assert new_order.expected_total_uzs == 50_000
    assert new_order.address == {
        "lat": 41.311081,
        "lon": 69.240562,
        "street": "Demo ko'cha",
        "house": "12",
        "apartment": None,
        "entrance": None,
        "floor": None,
        "landmark": None,
    }


async def test_create_order_rounds_coordinates_to_six_decimals(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    address = {"lat": 41.3110814999, "lon": -69.24056249, "street": "Demo ko'cha", "house": "12"}
    assert (await create(client, order_body(address=address))).status_code == 201
    [(_, call)] = orders.calls
    assert (call["new_order"].address["lat"], call["new_order"].address["lon"]) == (
        41.311081,
        -69.240562,
    )


async def test_order_detail_of_an_order_placed_before_courier_delivery(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    # Old snapshot shape: no coordinates, an area key that is ignored, a delivery charge still
    # included in the total.
    legacy = {"region": "chilonzor", "street": "Demo ko'cha", "house": "12"}
    orders.order = make_order(id=ORDER_ID, address=legacy, subtotal_uzs=50_000, total_uzs=65_000)
    body = (await client.get(f"{ORDERS}/{ORDER_ID}")).json()
    assert body["address"] == {
        "lat": None,
        "lon": None,
        "street": "Demo ko'cha",
        "house": "12",
        "apartment": None,
        "entrance": None,
        "floor": None,
        "landmark": None,
    }
    assert (body["subtotal_uzs"], body["total_uzs"]) == (50_000, 65_000)


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
            "address": {
                "street": " Demo ko'cha",
                "house": "12 ",
                "lon": 69.240562,
                "lat": 41.311081,
            },
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
        # An address without a map point, or with any unknown key (an area code), is refused.
        order_body(address={"region": "chilonzor", "street": "Demo ko'cha", "house": "1"}),
        order_body(
            address={
                "lat": 41.3,
                "lon": 69.2,
                "region": "chilonzor",
                "street": "Demo ko'cha",
                "house": "1",
            }
        ),
        order_body(address={"lat": 41.3, "lon": 69.2, "street": "Demo\nko'cha", "house": "1"}),
        order_body(address={"lat": 91, "lon": 69.2, "street": "Demo ko'cha", "house": "1"}),
        order_body(address={"lat": 41.3, "lon": -180.5, "street": "Demo ko'cha", "house": "1"}),
        order_body(address={"lat": "x", "lon": 69.2, "street": "Demo ko'cha", "house": "1"}),
        order_body(address={"lat": None, "lon": 69.2, "street": "Demo ko'cha", "house": "1"}),
        order_body(address={"lon": 69.2, "street": "Demo ko'cha", "house": "1"}),
        order_body(window_id=str(uuid.uuid4())),
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
    (CartEmptyError(), 409, {"code": "cart_empty"}),
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
                total_uzs=50_000,
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
    assert body["items"][0]["thumbnails"] == []
    assert orders.calls == [
        (
            "list_for_user",
            {"user_id": user.id, "page": 2, "page_size": 20, "status_group": OrderStatusGroup.ALL},
        )
    ]

    assert (await client.get(ORDERS)).status_code == 200
    assert orders.calls[-1] == (
        "list_for_user",
        {"user_id": user.id, "page": 1, "page_size": 20, "status_group": OrderStatusGroup.ALL},
    )


@pytest.mark.parametrize("group", ["all", "active", "delivering", "done", "cancelled"])
async def test_list_orders_filters_by_status_group(
    client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord, group: str
) -> None:
    response = await client.get(ORDERS, params={"status_group": group})
    assert response.status_code == 200, response.text
    assert orders.calls == [
        (
            "list_for_user",
            {
                "user_id": user.id,
                "page": 1,
                "page_size": 20,
                "status_group": OrderStatusGroup(group),
            },
        )
    ]


@pytest.mark.parametrize("group", ["ACTIVE", "open", ""])
async def test_list_orders_refuses_unknown_status_group(
    client: httpx.AsyncClient, orders: FakeOrderRepository, group: str
) -> None:
    body = error_of(
        await client.get(ORDERS, params={"status_group": group}), 422, "validation_error"
    )
    assert body["details"][0]["loc"] == ["query", "status_group"]
    assert orders.calls == []


async def test_list_orders_returns_thumbnails(
    client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    product_id = uuid.uuid4()
    orders.page = OrderPageRecord(
        items=(
            OrderSummaryRecord(
                id=ORDER_ID,
                number="261031-ABCDEF",
                status=OrderStatus.DELIVERED,
                total_uzs=50_000,
                item_count=2,
                created_at=CREATED_AT,
                thumbnails=(
                    OrderThumbnailRecord(
                        product_id=product_id,
                        name_uz="Non",
                        name_ru="Хлеб",
                        image_url="https://img.example.com/non.webp",
                    ),
                    OrderThumbnailRecord(
                        product_id=None, name_uz="Sut", name_ru="Молоко", image_url=None
                    ),
                ),
            ),
        ),
        total=1,
    )
    response = await client.get(ORDERS)
    assert response.status_code == 200
    assert response.json()["items"][0]["thumbnails"] == [
        {
            "product_id": str(product_id),
            "name_uz": "Non",
            "name_ru": "Хлеб",
            "image_url": "https://img.example.com/non.webp",
        },
        {"product_id": None, "name_uz": "Sut", "name_ru": "Молоко", "image_url": None},
    ]


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
        client.post(QUOTE),
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
        client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=ADJUST_BODY),
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
        await client.post(QUOTE),
        await create(client),
        await client.post(f"{ORDERS}/{ORDER_ID}/cancel", json={"reason": "Fikrim o'zgardi"}),
    ):
        error_of(response, 403, "csrf_failed")
    as_role(app, UserRole.OPERATOR)
    assert (await client.get(ADMIN)).status_code == 200
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/status", json={"status": "CONFIRMED"})
    error_of(response, 403, "csrf_failed")
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=ADJUST_BODY)
    error_of(response, 403, "csrf_failed")
    assert orders.names() == ["list_for_user", "get_for_user", "list_all"]


async def test_each_route_uses_its_own_rate_limit(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    limited = ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "5"})
    routes: list[tuple[Callable[..., Any], Callable[[], Any]]] = [
        (
            order_routes.CHECKOUT_QUOTE_LIMIT,
            lambda: client.post(QUOTE),
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
                await client.post(QUOTE, headers=headers),
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

        assert (await client.post(QUOTE, headers=csrf)).status_code == 200
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
            auth_method="telegram_oidc",
            entrance="admin",
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
        await client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=ADJUST_BODY),
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


# --- shortage at picking (ADR 0018) ---------------------------------------------------------------


@pytest.mark.parametrize("role", [UserRole.OPERATOR, UserRole.ADMIN])
async def test_staff_can_lower_an_order_line(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository, role: UserRole
) -> None:
    staff = as_role(app, role)
    response = await client.patch(
        f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}",
        json={"quantity": 1, "reason": " Ezilgan ", "mark_out_of_stock": True},
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["can_adjust_items"] is True
    assert body["adjustments"] == []
    assert orders.calls[-1] == (
        "adjust_item",
        {
            "order_id": ORDER_ID,
            "product_id": PRODUCT_ID,
            "quantity": 1,
            "reason": "Ezilgan",
            "mark_out_of_stock": True,
            "actor": Actor(user_id=staff.id, role=role),
        },
    )
    # ``mark_out_of_stock`` defaults to false.
    await client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=ADJUST_BODY)
    assert orders.calls[-1][1]["mark_out_of_stock"] is False


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            OrderNotAdjustableError("READY_FOR_DELIVERY"),
            (409, {"code": "order_not_adjustable", "current_status": "READY_FOR_DELIVERY"}),
        ),
        (InvalidQuantityError(2), (409, {"code": "invalid_quantity", "available_quantity": 2})),
        (OrderItemNotFoundError(), (404, {"code": "order_item_not_found"})),
        (OrderNotFoundError(), (404, {"code": "order_not_found"})),
    ],
)
async def test_adjust_errors(
    app: FastAPI,
    client: httpx.AsyncClient,
    orders: FakeOrderRepository,
    error: CheckoutError,
    expected: tuple[int, dict[str, Any]],
) -> None:
    as_role(app, UserRole.OPERATOR)
    orders.error = error
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=ADJUST_BODY)
    status, fields = expected
    assert response.status_code == status
    body = response.json()["error"]
    assert {key: value for key, value in body.items() if key != "message"} == fields


@pytest.mark.parametrize(
    "body",
    [
        {"quantity": -1, "reason": "Javonda qolmadi"},
        {"quantity": 100, "reason": "Javonda qolmadi"},
        {"quantity": 1, "reason": "ab"},
        {"quantity": 1, "reason": "x" * 301},
        {"quantity": 1},
        {"reason": "Javonda qolmadi"},
        {"quantity": 1, "reason": "Javonda qolmadi", "mark_out_of_stock": None},
        {"quantity": 1, "reason": "Javonda qolmadi", "extra": 1},
        {"quantity": "1.5", "reason": "Javonda qolmadi"},
    ],
)
async def test_adjust_body_validation(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository, body: dict[str, Any]
) -> None:
    as_role(app, UserRole.OPERATOR)
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/items/{PRODUCT_ID}", json=body)
    error_of(response, 422, "validation_error")
    response = await client.patch(f"{ADMIN}/{ORDER_ID}/items/not-a-uuid", json=ADJUST_BODY)
    error_of(response, 422, "validation_error")
    assert orders.calls == []


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
    assert not any(path.startswith("/api/v1/delivery") for path in paths)
    assert not any(path.startswith("/api/v1/admin/delivery") for path in paths)
    assert "requestBody" not in paths["/api/v1/checkout/quote"]["post"]
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


# --- phone verification gate ----------------------------------------------------------------------


async def test_order_needs_a_verified_phone_when_required(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository
) -> None:
    app.state.settings = app.state.settings.model_copy(
        update={"checkout_require_verified_phone": True}
    )
    error_of(await create(client), 409, "phone_verification_required")
    assert orders.calls == []


async def test_verified_phone_passes_the_gate(
    app: FastAPI, client: httpx.AsyncClient, orders: FakeOrderRepository, user: UserRecord
) -> None:
    app.state.settings = app.state.settings.model_copy(
        update={"checkout_require_verified_phone": True}
    )
    verified = dataclasses.replace(user, phone_verified=True)
    app.dependency_overrides[auth_deps.get_current_user] = lambda: verified
    response = await create(client)
    assert response.status_code == 201, response.text
