"""Cart routes against a fake repository (no database).

The auth interface is stubbed in ``app.api.auth_deps`` (the session work lands separately), so these
tests override ``get_current_user`` / ``require_csrf`` and the module-level rate-limit dependencies
of the cart routes via ``app.dependency_overrides``.
"""

import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api import auth_deps
from app.api.routes import cart as cart_routes
from app.core.errors import ApiError
from app.domain.cart import (
    CartError,
    CartItemNotFoundError,
    CartLimitReachedError,
    InsufficientStockError,
    ProductInactiveError,
    ProductNotFoundError,
    QuantityLimitExceededError,
)
from app.repositories.cart import CartLineRecord, CartRecord
from app.repositories.users import UserRecord
from tests.catalog_factories import make_line, make_product, make_user

PRODUCT_ID = uuid.uuid4()
ITEMS = "/api/v1/cart/items"


class FakeCartRepository:
    def __init__(self) -> None:
        self.cart = CartRecord(lines=())
        self.error: CartError | None = None
        self.calls: list[tuple[str, uuid.UUID, uuid.UUID | None, int | None]] = []

    def _result(self) -> CartRecord:
        if self.error is not None:
            raise self.error
        return self.cart

    async def get_cart(self, user_id: uuid.UUID) -> CartRecord:
        self.calls.append(("get", user_id, None, None))
        return self._result()

    async def add_item(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord:
        self.calls.append(("add", user_id, product_id, quantity))
        return self._result()

    async def set_item_quantity(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord:
        self.calls.append(("set", user_id, product_id, quantity))
        return self._result()

    async def remove_item(self, user_id: uuid.UUID, product_id: uuid.UUID) -> CartRecord:
        self.calls.append(("remove", user_id, product_id, None))
        return self._result()


async def _allow() -> None:
    return None


def _raiser(error: ApiError) -> Callable[[], Any]:
    async def dependency() -> None:
        raise error

    return dependency


@pytest.fixture
def user() -> UserRecord:
    return make_user()


@pytest.fixture
def carts(app: FastAPI, user: UserRecord) -> FakeCartRepository:
    repository = FakeCartRepository()
    app.dependency_overrides[cart_routes.get_cart_repository] = lambda: repository
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    app.dependency_overrides[auth_deps.require_csrf] = _allow
    app.dependency_overrides[cart_routes.CART_READ_LIMIT] = _allow
    app.dependency_overrides[cart_routes.CART_WRITE_LIMIT] = _allow
    return repository


# --- GET /cart ----------------------------------------------------------------------------------


async def test_get_empty_cart(
    client: httpx.AsyncClient, carts: FakeCartRepository, user: UserRecord
) -> None:
    response = await client.get("/api/v1/cart")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "items": [],
        "item_count": 0,
        "subtotal_uzs": 0,
        "total_uzs": 0,
        "has_issues": False,
    }
    assert carts.calls == [("get", user.id, None, None)]


async def test_cart_totals_exclude_lines_with_issues(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    carts.cart = CartRecord(
        lines=(
            make_line(make_product(slug="a", price_uzs=12_000), quantity=3),
            make_line(make_product(slug="b", price_uzs=5_000, stock_quantity=10), quantity=2),
            make_line(make_product(slug="c", price_uzs=99_000), quantity=1, is_available=False),
            make_line(make_product(slug="d", price_uzs=7_000, stock_quantity=3), quantity=4),
        )
    )
    body = (await client.get("/api/v1/cart")).json()
    assert [line["product"]["slug"] for line in body["items"]] == ["a", "b", "c", "d"]
    assert [line["issue"] for line in body["items"]] == [
        None,
        None,
        "product_inactive",
        "insufficient_stock",
    ]
    assert [line["line_total_uzs"] for line in body["items"]] == [36_000, 10_000, 99_000, 28_000]
    assert body["subtotal_uzs"] == 46_000
    assert body["total_uzs"] == 46_000
    assert body["item_count"] == 5
    assert body["has_issues"] is True
    assert set(body["items"][0]) == {"product", "quantity", "line_total_uzs", "issue"}


# --- writes: success ------------------------------------------------------------------------------


async def test_add_item(
    client: httpx.AsyncClient, carts: FakeCartRepository, user: UserRecord
) -> None:
    carts.cart = CartRecord(lines=(make_line(quantity=2),))
    response = await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 2})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["item_count"] == 2
    assert carts.calls == [("add", user.id, PRODUCT_ID, 2)]


async def test_set_quantity(
    client: httpx.AsyncClient, carts: FakeCartRepository, user: UserRecord
) -> None:
    response = await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 99})
    assert response.status_code == 200
    assert carts.calls == [("set", user.id, PRODUCT_ID, 99)]


async def test_delete_item(
    client: httpx.AsyncClient, carts: FakeCartRepository, user: UserRecord
) -> None:
    response = await client.delete(f"{ITEMS}/{PRODUCT_ID}")
    assert response.status_code == 200
    assert response.json()["items"] == []
    assert carts.calls == [("remove", user.id, PRODUCT_ID, None)]


# --- writes: domain errors ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (ProductNotFoundError(), 404, "product_not_found"),
        (CartItemNotFoundError(), 404, "cart_item_not_found"),
        (ProductInactiveError(), 409, "product_inactive"),
        (CartLimitReachedError(), 409, "cart_limit_reached"),
    ],
)
async def test_domain_errors_map_to_envelope(
    client: httpx.AsyncClient,
    carts: FakeCartRepository,
    error: CartError,
    status: int,
    code: str,
) -> None:
    carts.error = error
    for response in (
        await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 1}),
        await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 1}),
    ):
        assert response.status_code == status
        body = response.json()["error"]
        assert body["code"] == code
        assert "available_quantity" not in body
        assert "cache-control" not in response.headers


async def test_insufficient_stock_reports_available_quantity(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    carts.error = InsufficientStockError(4)
    response = await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 5})
    assert response.status_code == 409
    assert response.json() == {
        "error": {
            "code": "insufficient_stock",
            "message": "Not enough stock",
            "available_quantity": 4,
        }
    }


async def test_zero_available_quantity_is_still_reported(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    carts.error = InsufficientStockError(0)
    response = await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 1})
    assert response.json()["error"]["available_quantity"] == 0


async def test_line_cap_overflow_is_a_validation_error(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    carts.error = QuantityLimitExceededError()
    response = await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 50})
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    assert body["details"] == [
        {"loc": ["body", "quantity"], "msg": "Quantity per item cannot exceed 99"}
    ]


# --- writes: request validation -------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"product_id": str(PRODUCT_ID), "quantity": 0},
        {"product_id": str(PRODUCT_ID), "quantity": 100},
        {"product_id": str(PRODUCT_ID), "quantity": -3},
        {"product_id": str(PRODUCT_ID), "quantity": 1.5},
        {"product_id": str(PRODUCT_ID), "quantity": "2x"},
        {"product_id": str(PRODUCT_ID)},
        {"quantity": 1},
        {"product_id": "not-a-uuid", "quantity": 1},
        {"product_id": str(PRODUCT_ID), "quantity": 1, "price_uzs": 1},
    ],
)
async def test_add_rejects_invalid_bodies(
    client: httpx.AsyncClient, carts: FakeCartRepository, payload: dict[str, object]
) -> None:
    response = await client.post(ITEMS, json=payload)
    assert response.status_code == 422, payload
    assert response.json()["error"]["code"] == "validation_error"
    assert carts.calls == []


@pytest.mark.parametrize(
    "payload", [{"quantity": 0}, {"quantity": 100}, {}, {"quantity": 1, "x": 1}]
)
async def test_set_rejects_invalid_bodies(
    client: httpx.AsyncClient, carts: FakeCartRepository, payload: dict[str, object]
) -> None:
    response = await client.put(f"{ITEMS}/{PRODUCT_ID}", json=payload)
    assert response.status_code == 422, payload
    assert carts.calls == []


async def test_item_path_must_be_a_uuid(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    assert (await client.put(f"{ITEMS}/nope", json={"quantity": 1})).status_code == 422
    assert (await client.delete(f"{ITEMS}/nope")).status_code == 422


async def test_quantity_bounds_are_inclusive(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    for quantity in (1, 99):
        response = await client.post(
            ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": quantity}
        )
        assert response.status_code == 200


# --- auth / CSRF / rate-limit wiring --------------------------------------------------------------


async def test_every_route_requires_a_session(
    app: FastAPI, client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    app.dependency_overrides[auth_deps.get_current_user] = _raiser(
        ApiError(401, "session_required", "Sign in required")
    )
    for response in (
        await client.get("/api/v1/cart"),
        await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 1}),
        await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 1}),
        await client.delete(f"{ITEMS}/{PRODUCT_ID}"),
    ):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "session_required"
    assert carts.calls == []


async def test_writes_require_csrf_but_reads_do_not(
    app: FastAPI, client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF check failed")
    )
    assert (await client.get("/api/v1/cart")).status_code == 200
    for response in (
        await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 1}),
        await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 1}),
        await client.delete(f"{ITEMS}/{PRODUCT_ID}"),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "csrf_failed"
    assert [call[0] for call in carts.calls] == ["get"]


async def test_read_and_write_use_their_own_rate_limits(
    app: FastAPI, client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    limited = ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "7"})

    app.dependency_overrides[cart_routes.CART_READ_LIMIT] = _raiser(limited)
    response = await client.get("/api/v1/cart")
    assert (response.status_code, response.headers["retry-after"]) == (429, "7")
    assert (await client.delete(f"{ITEMS}/{PRODUCT_ID}")).status_code == 200

    app.dependency_overrides[cart_routes.CART_READ_LIMIT] = _allow
    app.dependency_overrides[cart_routes.CART_WRITE_LIMIT] = _raiser(limited)
    assert (await client.get("/api/v1/cart")).status_code == 200
    for response in (
        await client.post(ITEMS, json={"product_id": str(PRODUCT_ID), "quantity": 1}),
        await client.put(f"{ITEMS}/{PRODUCT_ID}", json={"quantity": 1}),
        await client.delete(f"{ITEMS}/{PRODUCT_ID}"),
    ):
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"


async def test_cart_lines_keep_repository_order(
    client: httpx.AsyncClient, carts: FakeCartRepository
) -> None:
    lines: tuple[CartLineRecord, ...] = tuple(
        make_line(make_product(slug=f"p{i}"), quantity=i + 1) for i in range(5)
    )
    carts.cart = CartRecord(lines=lines)
    body = (await client.get("/api/v1/cart")).json()
    assert [line["product"]["slug"] for line in body["items"]] == [f"p{i}" for i in range(5)]


# --- OpenAPI --------------------------------------------------------------------------------------


async def test_openapi_documents_cart(client: httpx.AsyncClient) -> None:
    spec = (await client.get("/api/v1/openapi.json")).json()
    paths = spec["paths"]
    envelope = "/ErrorEnvelope"
    operations = [
        (paths["/api/v1/cart"]["get"], ("401", "403", "429")),
        (paths["/api/v1/cart/items"]["post"], ("401", "403", "404", "409", "422", "429")),
        (
            paths["/api/v1/cart/items/{product_id}"]["put"],
            ("401", "403", "404", "409", "422", "429"),
        ),
        (
            paths["/api/v1/cart/items/{product_id}"]["delete"],
            ("401", "403", "404", "409", "422", "429"),
        ),
    ]
    for operation, statuses in operations:
        assert operation["responses"]["200"]["content"]["application/json"]["schema"][
            "$ref"
        ].endswith("/Cart")
        for status in statuses:
            schema = operation["responses"][status]["content"]["application/json"]["schema"]
            assert schema["$ref"].endswith(envelope)
    cart_line = spec["components"]["schemas"]["CartLine"]["properties"]
    assert set(cart_line) == {"product", "quantity", "line_total_uzs", "issue"}
    quantity = spec["components"]["schemas"]["AddCartItemRequest"]["properties"]["quantity"]
    assert (quantity["minimum"], quantity["maximum"]) == (1, 99)
