"""Admin catalog over HTTP against a real PostgreSQL schema built by the Alembic migrations.

Covers the product lifecycle (create, update, archive, restore, activate) with its audit trail
and its effect on the storefront, carts and existing orders; category tree rules; uniqueness
mapped from the database constraints; and the admin product list filters.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import func, select

from app.models.audit import AuditLog
from app.models.catalog import Category, Product
from app.models.enums import UserRole
from app.repositories.users import UserRecord
from tests.admin_factories import audit_rows, build_admin_app, error_of
from tests.db_data import (
    TEST_USER_HEADER,
    SessionFactory,
    add_category,
    add_product,
    add_user,
    add_zone,
)
from tests.db_support import INTEGRATION_MARKS
from tests.order_factories import order_body

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

CATEGORIES = "/api/v1/admin/categories"
PRODUCTS = "/api/v1/admin/products"


@dataclass
class Back:
    client: httpx.AsyncClient
    factory: SessionFactory
    admin: UserRecord
    customer: UserRecord
    category: Category

    def as_user(self, user: UserRecord | None = None) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.admin).id)}

    async def get(self, path: str, *, user: UserRecord | None = None, **kwargs: Any) -> Any:
        return await self.client.get(path, headers=self.as_user(user), **kwargs)

    async def send(
        self, method: str, path: str, json: Any = None, *, user: UserRecord | None = None
    ) -> httpx.Response:
        return await self.client.request(method, path, json=json, headers=self.as_user(user))

    async def product_row(self, product_id: str) -> Product | None:
        async with self.factory() as session:
            return await session.get(Product, uuid.UUID(product_id))

    async def count(self, model: type[Any], *where: Any) -> int:
        async with self.factory() as session:
            return (
                await session.execute(select(func.count()).select_from(model).where(*where))
            ).scalar_one()


@pytest_asyncio.fixture(loop_scope="module")
async def back(session_factory: SessionFactory) -> AsyncIterator[Back]:
    admin = await add_user(session_factory, role=UserRole.ADMIN)
    customer = await add_user(session_factory)
    category = await add_category(session_factory, "mevalar")
    await add_zone(session_factory, "demo-markaziy", ["chilonzor"], min_order_uzs=0)
    app = build_admin_app(session_factory, [admin, customer])
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Back(client, session_factory, admin, customer, category)


def product_body(category: Category, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "sku": "DEMO-OLMA",
        "slug": "demo-olma",
        "category_id": str(category.id),
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "description_uz": "Shirin olma",
        "unit": "kg",
        "price_uzs": 20_000,
        "stock_quantity": 50,
    }
    body.update(overrides)
    return body


# --- product lifecycle ------------------------------------------------------------------------


async def test_product_lifecycle(back: Back) -> None:
    # Create.
    response = await back.send("POST", PRODUCTS, product_body(back.category))
    assert response.status_code == 201, response.text
    product = response.json()
    product_id = product["id"]
    assert product["is_active"] is True
    assert product["archived_at"] is None

    # Update price and stock: the audit row carries from/to.
    response = await back.send(
        "PATCH", f"{PRODUCTS}/{product_id}", {"price_uzs": 25_000, "stock_quantity": 40}
    )
    assert response.status_code == 200, response.text
    assert response.json()["price_uzs"] == 25_000
    [created, updated] = await audit_rows(back.factory, AuditLog.entity_id == product_id)
    assert created.action == "product.create"
    assert created.actor_user_id == back.admin.id
    assert created.actor_role is UserRole.ADMIN
    assert created.details["changes"]["price_uzs"] == {"from": None, "to": 20_000}
    assert created.details["changes"]["category_id"] == {
        "from": None,
        "to": str(back.category.id),
    }
    assert "description_uz" not in created.details["changes"]
    assert updated.action == "product.update"
    assert updated.details == {
        "changes": {
            "price_uzs": {"from": 20_000, "to": 25_000},
            "stock_quantity": {"from": 50, "to": 40},
        }
    }

    # A customer orders it, then puts it in the cart again.
    customer = back.customer
    add = {"product_id": product_id, "quantity": 2}
    assert (await back.send("POST", "/api/v1/cart/items", add, user=customer)).status_code == 200
    quote = await back.send(
        "POST", "/api/v1/checkout/quote", {"district": "chilonzor"}, user=customer
    )
    assert quote.status_code == 200, quote.text
    order_response = await back.client.post(
        "/api/v1/orders",
        json=order_body(expected_total_uzs=quote.json()["total_uzs"]),
        headers={**back.as_user(customer), "Idempotency-Key": str(uuid.uuid4())},
    )
    assert order_response.status_code == 201, order_response.text
    order = order_response.json()
    assert (await back.send("POST", "/api/v1/cart/items", add, user=customer)).status_code == 200
    public = await back.client.get("/api/v1/products")
    assert product_id in [item["id"] for item in public.json()["items"]]

    # Archive (DELETE): hidden from the storefront, unavailable in carts, orders untouched.
    response = await back.send("DELETE", f"{PRODUCTS}/{product_id}")
    assert response.status_code == 200, response.text
    archived = response.json()
    assert archived["archived_at"] is not None
    assert archived["is_active"] is False
    public = await back.client.get("/api/v1/products")
    assert product_id not in [item["id"] for item in public.json()["items"]]
    assert (await back.client.get("/api/v1/products/demo-olma")).status_code == 404
    cart = (await back.get("/api/v1/cart", user=customer)).json()
    [line] = cart["items"]
    assert line["issue"] == "product_inactive"
    assert cart["item_count"] == 0
    detail = await back.get(f"/api/v1/orders/{order['id']}", user=customer)
    assert detail.status_code == 200
    assert detail.json()["items"] == order["items"]
    assert detail.json()["items"][0]["product_id"] == product_id
    assert detail.json()["items"][0]["unit_price_uzs"] == 25_000
    admin_detail = await back.get(f"/api/v1/admin/orders/{order['id']}")
    assert admin_detail.status_code == 200
    # Archiving twice changes nothing.
    again = await back.send("DELETE", f"{PRODUCTS}/{product_id}")
    assert again.json()["archived_at"] == archived["archived_at"]

    # An archived product cannot be edited (or re-activated) until restored.
    for body in ({"price_uzs": 1}, {"is_active": True}):
        error_of(
            await back.send("PATCH", f"{PRODUCTS}/{product_id}", body), 409, "product_archived"
        )
    # It is still listed for admins, under "archived" and "all" only.
    for status, listed in (("archived", True), ("all", True), (None, False), ("inactive", False)):
        params = {"status": status} if status else {}
        page = (await back.get(PRODUCTS, params=params)).json()
        assert (product_id in [item["id"] for item in page["items"]]) is listed, status

    # Restore: no longer archived but still inactive (and hidden).
    response = await back.send("POST", f"{PRODUCTS}/{product_id}/restore")
    assert response.status_code == 200
    assert response.json()["archived_at"] is None
    assert response.json()["is_active"] is False
    assert (await back.client.get("/api/v1/products/demo-olma")).status_code == 404

    # Activate.
    response = await back.send("PATCH", f"{PRODUCTS}/{product_id}", {"is_active": True})
    assert response.json()["is_active"] is True
    assert (await back.client.get("/api/v1/products/demo-olma")).status_code == 200
    cart = (await back.get("/api/v1/cart", user=customer)).json()
    assert cart["items"][0]["issue"] is None

    # Never hard-deleted; every step audited in order.
    assert await back.product_row(product_id) is not None
    actions = [
        row.action for row in await audit_rows(back.factory, AuditLog.entity_id == product_id)
    ]
    assert actions == [
        "product.create",
        "product.update",
        "product.archive",
        "product.restore",
        "product.update",
    ]
    archive_row = (await audit_rows(back.factory, AuditLog.action == "product.archive"))[0]
    assert archive_row.details["changes"] == {
        "archived": {"from": False, "to": True},
        "is_active": {"from": True, "to": False},
    }


async def test_product_constraints(back: Back) -> None:
    first = await back.send("POST", PRODUCTS, product_body(back.category))
    assert first.status_code == 201
    error_of(
        await back.send("POST", PRODUCTS, product_body(back.category, slug="other")),
        409,
        "sku_taken",
    )
    error_of(
        await back.send("POST", PRODUCTS, product_body(back.category, sku="OTHER")),
        409,
        "slug_taken",
    )
    error_of(
        await back.send(
            "POST", PRODUCTS, product_body(back.category, category_id=str(uuid.uuid4()))
        ),
        422,
        "category_not_found",
    )
    second = await back.send(
        "POST", PRODUCTS, product_body(back.category, sku="DEMO-2", slug="demo-2")
    )
    second_id = second.json()["id"]
    error_of(
        await back.send("PATCH", f"{PRODUCTS}/{second_id}", {"slug": "demo-olma"}),
        409,
        "slug_taken",
    )
    error_of(
        await back.send("PATCH", f"{PRODUCTS}/{second_id}", {"sku": "DEMO-OLMA"}),
        409,
        "sku_taken",
    )
    # old_price must stay above price after the merge with the stored values.
    error_of(
        await back.send("PATCH", f"{PRODUCTS}/{second_id}", {"old_price_uzs": 20_000}),
        422,
        "validation_error",
    )
    ok = await back.send("PATCH", f"{PRODUCTS}/{second_id}", {"old_price_uzs": 30_000})
    assert ok.status_code == 200
    error_of(
        await back.send("PATCH", f"{PRODUCTS}/{second_id}", {"price_uzs": 30_000}),
        422,
        "validation_error",
    )
    error_of(
        await back.send("PATCH", f"{PRODUCTS}/{uuid.uuid4()}", {"price_uzs": 1}),
        404,
        "product_not_found",
    )
    # Refused writes left no audit rows behind.
    actions = [row.action for row in await audit_rows(back.factory)]
    assert actions == ["product.create", "product.create", "product.update"]


async def test_admin_product_list(back: Back) -> None:
    other = await add_category(back.factory, "sabzavotlar")
    await add_product(back.factory, back.category, "b", name_uz="Banan 100%", sort_order=2)
    await add_product(back.factory, back.category, "a", name_uz="Anor", sort_order=2)
    await add_product(back.factory, back.category, "z", name_uz="Zira", sort_order=-1)
    await add_product(back.factory, other, "off", name_uz="Piyoz", is_active=False)
    await add_product(back.factory, other, "gone", name_uz="Eski", is_active=False)
    gone = await add_product(
        back.factory, other, "gone2", name_uz="Eski 2", is_active=False, archived_at=func.now()
    )

    def names(page: dict[str, Any]) -> list[str]:
        return [item["name_uz"] for item in page["items"]]

    page = (await back.get(PRODUCTS)).json()
    assert names(page) == ["Zira", "Eski", "Piyoz", "Anor", "Banan 100%"]
    assert page["total"] == 5
    assert names((await back.get(PRODUCTS, params={"status": "active"})).json()) == [
        "Zira",
        "Anor",
        "Banan 100%",
    ]
    inactive = (await back.get(PRODUCTS, params={"status": "inactive"})).json()
    assert names(inactive) == ["Eski", "Piyoz"]
    archived = (await back.get(PRODUCTS, params={"status": "archived"})).json()
    assert [item["id"] for item in archived["items"]] == [str(gone.id)]
    by_category = (await back.get(PRODUCTS, params={"category_id": str(other.id)})).json()
    assert names(by_category) == ["Eski", "Piyoz"]
    # q is matched literally: "%" and "_" are not wildcards.
    assert names((await back.get(PRODUCTS, params={"q": "100%"})).json()) == ["Banan 100%"]
    assert names((await back.get(PRODUCTS, params={"q": "%"})).json()) == ["Banan 100%"]
    assert names((await back.get(PRODUCTS, params={"q": "_"})).json()) == []
    assert names((await back.get(PRODUCTS, params={"q": "DEMO-a"})).json()) == ["Anor"]
    second = (await back.get(PRODUCTS, params={"page": 2, "page_size": 2})).json()
    assert names(second) == ["Piyoz", "Anor"]
    assert second["total_pages"] == 3


# --- categories -------------------------------------------------------------------------------


async def test_category_tree_rules(back: Back) -> None:
    root = (
        await back.send(
            "POST", CATEGORIES, {"slug": "oziq-ovqat", "name_uz": "Oziq", "name_ru": "Еда"}
        )
    ).json()
    child = await back.send(
        "POST",
        CATEGORIES,
        {"slug": "non", "name_uz": "Non", "name_ru": "Хлеб", "parent_id": root["id"]},
    )
    assert child.status_code == 201, child.text
    child_id = child.json()["id"]
    grandchild = (
        await back.send(
            "POST",
            CATEGORIES,
            {"slug": "lavash", "name_uz": "Lavash", "name_ru": "Лаваш", "parent_id": child_id},
        )
    ).json()

    # Cycles: itself, a child, a grandchild.
    for parent in (root["id"], child_id, grandchild["id"]):
        error_of(
            await back.send("PATCH", f"{CATEGORIES}/{root['id']}", {"parent_id": parent}),
            409,
            "category_cycle",
        )
    error_of(
        await back.send("PATCH", f"{CATEGORIES}/{root['id']}", {"parent_id": str(uuid.uuid4())}),
        422,
        "category_not_found",
    )
    error_of(
        await back.send("POST", CATEGORIES, {"slug": "non", "name_uz": "x", "name_ru": "x"}),
        409,
        "slug_taken",
    )
    error_of(
        await back.send("PATCH", f"{CATEGORIES}/{uuid.uuid4()}", {"name_uz": "x"}),
        404,
        "category_not_found",
    )

    # Moving a subtree elsewhere is fine; moving to the top level too.
    moved = await back.send(
        "PATCH", f"{CATEGORIES}/{grandchild['id']}", {"parent_id": str(back.category.id)}
    )
    assert moved.status_code == 200
    assert moved.json()["parent_id"] == str(back.category.id)
    top = await back.send("PATCH", f"{CATEGORIES}/{grandchild['id']}", {"parent_id": None})
    assert top.json()["parent_id"] is None

    # Delete: refused while it has children or any product (archived included).
    error_of(await back.send("DELETE", f"{CATEGORIES}/{root['id']}"), 409, "category_not_empty")
    async with back.factory() as session:
        child_row = await session.get(Category, uuid.UUID(child_id))
    assert child_row is not None
    await add_product(back.factory, child_row, "old", is_active=False, archived_at=func.now())
    error_of(await back.send("DELETE", f"{CATEGORIES}/{child_id}"), 409, "category_not_empty")

    listing = (await back.get(CATEGORIES)).json()["items"]
    counts = {item["slug"]: (item["product_count"], item["child_count"]) for item in listing}
    assert counts["oziq-ovqat"] == (0, 1)
    assert counts["non"] == (1, 0)

    deleted = await back.send("DELETE", f"{CATEGORIES}/{grandchild['id']}")
    assert deleted.status_code == 204
    error_of(
        await back.send("DELETE", f"{CATEGORIES}/{grandchild['id']}"), 404, "category_not_found"
    )
    assert await back.count(Category, Category.id == uuid.UUID(grandchild["id"])) == 0
    actions = [
        row.action for row in await audit_rows(back.factory, AuditLog.entity_type == "category")
    ]
    assert actions == [
        "category.create",
        "category.create",
        "category.create",
        "category.update",
        "category.update",
        "category.delete",
    ]
    delete_row = (await audit_rows(back.factory, AuditLog.action == "category.delete"))[0]
    assert delete_row.details == {"slug": "lavash"}
    move_row = (await audit_rows(back.factory, AuditLog.action == "category.update"))[0]
    assert move_row.details == {
        "changes": {"parent_id": {"from": child_id, "to": str(back.category.id)}}
    }


async def test_category_update_without_changes_is_not_audited(back: Back) -> None:
    response = await back.send(
        "PATCH", f"{CATEGORIES}/{back.category.id}", {"slug": back.category.slug}
    )
    assert response.status_code == 200
    assert await back.count(AuditLog) == 0
