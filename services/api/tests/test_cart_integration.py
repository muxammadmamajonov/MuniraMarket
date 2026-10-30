"""Cart over HTTP against a real PostgreSQL schema built by the Alembic migrations.

Covers the write rules (stock, 99-per-line, 50-lines), server-side totals, products that change
after being added, user isolation and, with real concurrent requests, the locking strategy.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select

from app.models.cart import Cart, CartItem
from app.models.catalog import Category, Product
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

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS

CART = "/api/v1/cart"
ITEMS = "/api/v1/cart/items"


class Shop:
    """Two signed-in users and a small catalog, plus request helpers."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        factory: SessionFactory,
        user: UserRecord,
        other_user: UserRecord,
        category: Category,
    ) -> None:
        self.client = client
        self.factory = factory
        self.user = user
        self.other_user = other_user
        self.category = category

    async def product(self, slug: str, **kwargs: Any) -> Product:
        return await add_product(self.factory, self.category, slug, **kwargs)

    async def add(
        self, product: Product, quantity: int = 1, *, user: UserRecord | None = None
    ) -> httpx.Response:
        return await self.client.post(
            ITEMS,
            json={"product_id": str(product.id), "quantity": quantity},
            headers=self._headers(user),
        )

    async def set(
        self, product: Product, quantity: int, *, user: UserRecord | None = None
    ) -> httpx.Response:
        return await self.client.put(
            f"{ITEMS}/{product.id}", json={"quantity": quantity}, headers=self._headers(user)
        )

    async def remove(self, product: Product, *, user: UserRecord | None = None) -> httpx.Response:
        return await self.client.delete(f"{ITEMS}/{product.id}", headers=self._headers(user))

    async def cart(self, *, user: UserRecord | None = None) -> dict[str, Any]:
        response = await self.client.get(CART, headers=self._headers(user))
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    def _headers(self, user: UserRecord | None) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.user).id)}

    async def count(self, model: type[Cart] | type[CartItem]) -> int:
        async with self.factory() as session:
            return (await session.execute(select(func.count()).select_from(model))).scalar_one()


@pytest_asyncio.fixture(loop_scope="module")
async def shop(session_factory: SessionFactory) -> AsyncIterator[Shop]:
    user = await add_user(session_factory)
    other_user = await add_user(session_factory)
    category = await add_category(session_factory, "cart-cat")
    app = build_app(session_factory, [user, other_user])
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Shop(client, session_factory, user, other_user, category)


def quantities(cart: dict[str, Any]) -> dict[str, int]:
    return {line["product"]["slug"]: line["quantity"] for line in cart["items"]}


def error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- reading --------------------------------------------------------------------------------------


async def test_empty_cart_is_not_created_by_reading(shop: Shop) -> None:
    response = await shop.client.get(CART, headers={TEST_USER_HEADER: str(shop.user.id)})
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "items": [],
        "item_count": 0,
        "subtotal_uzs": 0,
        "total_uzs": 0,
        "has_issues": False,
    }
    assert await shop.count(Cart) == 0


# --- add / update / delete ------------------------------------------------------------------------


async def test_add_creates_cart_and_accumulates(shop: Shop) -> None:
    apple = await shop.product("apple", price=12_000, old_price=15_000, stock=50)

    response = await shop.add(apple, 2)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert len(body["items"]) == 1
    line = body["items"][0]
    assert line["quantity"] == 2
    assert line["line_total_uzs"] == 24_000
    assert line["issue"] is None
    assert line["product"]["id"] == str(apple.id)
    assert line["product"]["old_price_uzs"] == 15_000
    assert (body["item_count"], body["subtotal_uzs"], body["total_uzs"]) == (2, 24_000, 24_000)
    assert body["has_issues"] is False

    assert quantities((await shop.add(apple, 3)).json()) == {"apple": 5}
    assert quantities(await shop.cart()) == {"apple": 5}
    assert (await shop.count(Cart), await shop.count(CartItem)) == (1, 1)


async def test_lines_keep_the_order_they_were_added(shop: Shop) -> None:
    products = [await shop.product(f"p{index}") for index in range(4)]
    for product in (products[2], products[0], products[3], products[1]):
        await shop.add(product)
    await shop.add(products[2], 5)  # touching an existing line does not move it
    await shop.set(products[0], 7)
    assert list(quantities(await shop.cart())) == ["p2", "p0", "p3", "p1"]


async def test_set_quantity_replaces_it(shop: Shop) -> None:
    apple = await shop.product("apple", price=1_000)
    await shop.add(apple, 4)
    response = await shop.set(apple, 2)
    assert response.status_code == 200
    assert quantities(response.json()) == {"apple": 2}
    assert response.json()["subtotal_uzs"] == 2_000


async def test_set_quantity_of_a_missing_line_is_404(shop: Shop) -> None:
    apple = await shop.product("apple")
    banana = await shop.product("banana")
    error(await shop.set(apple, 1), 404, "cart_item_not_found")  # no cart at all
    assert await shop.count(Cart) == 0
    await shop.add(banana)
    error(await shop.set(apple, 1), 404, "cart_item_not_found")  # cart exists, line does not


async def test_delete_is_idempotent(shop: Shop) -> None:
    apple = await shop.product("apple")
    banana = await shop.product("banana")

    response = await shop.remove(apple)  # no cart yet
    assert response.status_code == 200
    assert response.json()["items"] == []

    await shop.add(apple)
    await shop.add(banana)
    assert quantities((await shop.remove(apple)).json()) == {"banana": 1}
    assert quantities((await shop.remove(apple)).json()) == {"banana": 1}
    assert (await shop.remove(banana)).json()["items"] == []


async def test_writes_bump_the_cart_timestamp(shop: Shop) -> None:
    apple = await shop.product("apple")
    await shop.add(apple)

    async def updated_at() -> Any:
        async with shop.factory() as session:
            return (await session.execute(select(Cart.updated_at))).scalar_one()

    first = await updated_at()
    await shop.add(apple)
    second = await updated_at()
    await shop.remove(apple)
    third = await updated_at()
    assert first < second < third


async def test_carts_are_private_per_user(shop: Shop) -> None:
    apple = await shop.product("apple", price=1_000)
    banana = await shop.product("banana", price=2_000)
    await shop.add(apple, 2)
    await shop.add(banana, 5, user=shop.other_user)

    assert quantities(await shop.cart()) == {"apple": 2}
    assert quantities(await shop.cart(user=shop.other_user)) == {"banana": 5}
    # Removing "apple" for the other user touches nothing of the first user's cart.
    await shop.remove(apple, user=shop.other_user)
    assert quantities(await shop.cart()) == {"apple": 2}
    error(await shop.set(apple, 1, user=shop.other_user), 404, "cart_item_not_found")


# --- product errors ------------------------------------------------------------------------------


async def test_unknown_product_is_404_and_leaves_no_cart(shop: Shop) -> None:
    response = await shop.client.post(
        ITEMS,
        json={"product_id": str(uuid.uuid4()), "quantity": 1},
        headers={TEST_USER_HEADER: str(shop.user.id)},
    )
    error(response, 404, "product_not_found")
    assert await shop.count(Cart) == 0


async def test_inactive_product_cannot_be_added_or_updated(shop: Shop) -> None:
    inactive = await shop.product("inactive", is_active=False)
    error(await shop.add(inactive), 409, "product_inactive")
    assert (await shop.count(Cart), await shop.count(CartItem)) == (0, 0)


async def test_product_in_inactive_category_chain_cannot_be_added(shop: Shop) -> None:
    hidden = await add_category(shop.factory, "hidden", is_active=False)
    deeper = await add_category(shop.factory, "deeper", parent=hidden)
    in_hidden = await add_product(shop.factory, hidden, "in-hidden")
    in_deeper = await add_product(shop.factory, deeper, "in-deeper")
    error(await shop.add(in_hidden), 409, "product_inactive")
    error(await shop.add(in_deeper), 409, "product_inactive")


# --- stock ---------------------------------------------------------------------------------------


async def test_exact_stock_is_ok_and_one_more_is_409_with_available_quantity(shop: Shop) -> None:
    product = await shop.product("limited", stock=5)
    assert quantities((await shop.add(product, 5)).json()) == {"limited": 5}

    body = error(await shop.add(product, 1), 409, "insufficient_stock")
    assert body["available_quantity"] == 5
    assert quantities(await shop.cart()) == {"limited": 5}  # unchanged


async def test_add_beyond_stock_in_one_step(shop: Shop) -> None:
    product = await shop.product("limited", stock=5)
    body = error(await shop.add(product, 6), 409, "insufficient_stock")
    assert body["available_quantity"] == 5
    assert await shop.count(Cart) == 0  # the failed first write left nothing behind


async def test_accumulated_quantity_is_checked_against_stock(shop: Shop) -> None:
    product = await shop.product("limited", stock=5)
    await shop.add(product, 3)
    body = error(await shop.add(product, 3), 409, "insufficient_stock")
    assert body["available_quantity"] == 5
    assert quantities(await shop.cart()) == {"limited": 3}


async def test_zero_stock_cannot_be_added(shop: Shop) -> None:
    product = await shop.product("sold-out", stock=0)
    body = error(await shop.add(product), 409, "insufficient_stock")
    assert body["available_quantity"] == 0


async def test_untracked_stock_has_no_limit_except_99(shop: Shop) -> None:
    product = await shop.product("plenty", stock=None)
    assert quantities((await shop.add(product, 99)).json()) == {"plenty": 99}


async def test_set_quantity_respects_stock(shop: Shop) -> None:
    product = await shop.product("limited", stock=5)
    await shop.add(product, 1)
    assert quantities((await shop.set(product, 5)).json()) == {"limited": 5}
    body = error(await shop.set(product, 6), 409, "insufficient_stock")
    assert body["available_quantity"] == 5
    assert quantities(await shop.cart()) == {"limited": 5}


# --- limits --------------------------------------------------------------------------------------


async def test_line_quantity_cap_is_99(shop: Shop) -> None:
    product = await shop.product("bulk")
    assert quantities((await shop.add(product, 99)).json()) == {"bulk": 99}

    response = await shop.add(product, 1)
    body = error(response, 422, "validation_error")
    assert body["details"][0]["loc"] == ["body", "quantity"]
    assert quantities(await shop.cart()) == {"bulk": 99}

    for quantity in (0, 100):
        assert (await shop.set(product, quantity)).status_code == 422
    assert quantities((await shop.set(product, 1)).json()) == {"bulk": 1}


async def test_cart_line_cap_is_50(shop: Shop) -> None:
    created = [await shop.product(f"line-{index:02d}") for index in range(51)]
    for product in created[:50]:
        assert (await shop.add(product)).status_code == 200
    assert len((await shop.cart())["items"]) == 50

    error(await shop.add(created[50]), 409, "cart_limit_reached")
    # Existing lines can still change, and removing one frees a slot.
    assert (await shop.add(created[0], 2)).status_code == 200
    assert (await shop.set(created[1], 3)).status_code == 200
    await shop.remove(created[2])
    assert (await shop.add(created[50])).status_code == 200
    assert len((await shop.cart())["items"]) == 50
    assert await shop.count(CartItem) == 50


# --- totals and changing products -----------------------------------------------------------------


async def test_totals_are_computed_on_the_server(shop: Shop) -> None:
    a = await shop.product("a", price=12_500)
    b = await shop.product("b", price=999_999)
    c = await shop.product("c", price=1)
    await shop.add(a, 3)
    await shop.add(b, 2)
    cart = (await shop.add(c, 7)).json()
    assert [line["line_total_uzs"] for line in cart["items"]] == [37_500, 1_999_998, 7]
    assert cart["subtotal_uzs"] == 37_500 + 1_999_998 + 7
    assert cart["total_uzs"] == cart["subtotal_uzs"]
    assert cart["item_count"] == 12
    assert cart["has_issues"] is False


async def test_price_changes_show_up_in_the_cart(shop: Shop) -> None:
    product = await shop.product("moving", price=10_000)
    await shop.add(product, 2)
    await update_row(shop.factory, Product, product.id, price_uzs=11_000)
    cart = await shop.cart()
    assert (cart["items"][0]["product"]["price_uzs"], cart["subtotal_uzs"]) == (11_000, 22_000)


async def test_product_deactivated_after_being_added_is_flagged_and_excluded(shop: Shop) -> None:
    keep = await shop.product("keep", price=5_000)
    drop = await shop.product("drop", price=7_000)
    await shop.add(keep, 2)
    await shop.add(drop, 3)
    await update_row(shop.factory, Product, drop.id, is_active=False)

    cart = await shop.cart()
    issues = {line["product"]["slug"]: line["issue"] for line in cart["items"]}
    assert issues == {"keep": None, "drop": "product_inactive"}
    assert cart["has_issues"] is True
    assert (cart["item_count"], cart["subtotal_uzs"], cart["total_uzs"]) == (2, 10_000, 10_000)
    # The line stays visible (with its normal line total), and can still be removed.
    assert cart["items"][1]["line_total_uzs"] == 21_000
    error(await shop.set(drop, 1), 409, "product_inactive")
    assert quantities((await shop.remove(drop)).json()) == {"keep": 2}


async def test_category_deactivated_after_being_added_flags_its_products(shop: Shop) -> None:
    parent = await add_category(shop.factory, "tree-root")
    child = await add_category(shop.factory, "tree-leaf", parent=parent)
    product = await add_product(shop.factory, child, "leafy", price=3_000)
    await shop.add(product, 2)
    assert (await shop.cart())["has_issues"] is False

    await update_row(shop.factory, Category, parent.id, is_active=False)
    cart = await shop.cart()
    assert cart["items"][0]["issue"] == "product_inactive"
    assert (cart["item_count"], cart["subtotal_uzs"]) == (0, 0)

    await update_row(shop.factory, Category, parent.id, is_active=True)
    assert (await shop.cart())["items"][0]["issue"] is None


async def test_stock_reduced_below_quantity_is_flagged_and_excluded(shop: Shop) -> None:
    product = await shop.product("shrinking", price=4_000, stock=10)
    other = await shop.product("steady", price=1_000)
    await shop.add(product, 6)
    await shop.add(other, 1)
    await update_row(shop.factory, Product, product.id, stock_quantity=4)

    cart = await shop.cart()
    assert [line["issue"] for line in cart["items"]] == ["insufficient_stock", None]
    assert cart["has_issues"] is True
    assert (cart["item_count"], cart["subtotal_uzs"]) == (1, 1_000)

    await update_row(shop.factory, Product, product.id, stock_quantity=0)
    assert (await shop.cart())["items"][0]["issue"] == "insufficient_stock"
    await update_row(shop.factory, Product, product.id, stock_quantity=6)
    cart = await shop.cart()
    assert cart["has_issues"] is False
    assert cart["subtotal_uzs"] == 25_000


# --- concurrency ----------------------------------------------------------------------------------


async def test_concurrent_adds_of_one_product_all_count(shop: Shop) -> None:
    product = await shop.product("busy")
    responses = await asyncio.gather(*(shop.add(product, 1) for _ in range(10)))
    assert [response.status_code for response in responses] == [200] * 10
    assert quantities(await shop.cart()) == {"busy": 10}
    assert (await shop.count(Cart), await shop.count(CartItem)) == (1, 1)


async def test_concurrent_adds_never_exceed_stock(shop: Shop) -> None:
    product = await shop.product("scarce", stock=5)
    responses = await asyncio.gather(*(shop.add(product, 1) for _ in range(10)))
    statuses = sorted(response.status_code for response in responses)
    assert statuses == [200] * 5 + [409] * 5
    for response in responses:
        if response.status_code == 409:
            body = error(response, 409, "insufficient_stock")
            assert body["available_quantity"] == 5
    assert quantities(await shop.cart()) == {"scarce": 5}


async def test_concurrent_adds_of_many_products_respect_the_line_cap(shop: Shop) -> None:
    created = [await shop.product(f"many-{index:02d}") for index in range(60)]
    responses = await asyncio.gather(*(shop.add(product) for product in created))
    statuses = sorted(response.status_code for response in responses)
    assert statuses == [200] * 50 + [409] * 10
    for response in responses:
        if response.status_code == 409:
            error(response, 409, "cart_limit_reached")
    assert len((await shop.cart())["items"]) == 50
    assert await shop.count(CartItem) == 50


async def test_concurrent_mixed_writes_leave_a_consistent_cart(shop: Shop) -> None:
    product = await shop.product("mixed", stock=20)
    await shop.add(product, 1)
    results = await asyncio.gather(
        *(shop.add(product, 1) for _ in range(5)),
        *(shop.set(product, 3) for _ in range(3)),
        shop.remove(product),
        return_exceptions=True,
    )
    for result in results:
        assert isinstance(result, httpx.Response)
        assert result.status_code in (200, 404)
    final = quantities(await shop.cart())
    assert set(final) <= {"mixed"}
    assert 0 <= final.get("mixed", 0) <= 20
    assert await shop.count(CartItem) == len(final)


async def test_concurrent_first_adds_for_different_users(shop: Shop) -> None:
    product = await shop.product("shared", stock=100)
    users = [await add_user(shop.factory) for _ in range(8)]
    # Resolve the extra users through the app's test-user lookup.
    transport = httpx.ASGITransport(
        app=build_app(shop.factory, [shop.user, *users]), raise_app_exceptions=True
    )
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        responses = await asyncio.gather(
            *(
                client.post(
                    ITEMS,
                    json={"product_id": str(product.id), "quantity": 2},
                    headers={TEST_USER_HEADER: str(user.id)},
                )
                for user in users
                for _ in range(3)
            )
        )
        assert {response.status_code for response in responses} == {200}
        for user in users:
            body = (await client.get(CART, headers={TEST_USER_HEADER: str(user.id)})).json()
            assert quantities(body) == {"shared": 6}
    assert await shop.count(Cart) == 8


@pytest.mark.parametrize("quantity", [1, 99])
async def test_add_quantity_bounds_hit_the_database_correctly(shop: Shop, quantity: int) -> None:
    product = await shop.product(f"bound-{quantity}")
    assert quantities((await shop.add(product, quantity)).json()) == {f"bound-{quantity}": quantity}
