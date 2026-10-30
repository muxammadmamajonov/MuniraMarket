"""Catalog over HTTP against a real PostgreSQL schema built by the Alembic migrations."""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import pytest_asyncio

from app.dev.seed import DEMO_CATEGORIES, DEMO_PRODUCTS, seed
from app.models.catalog import Category, Product
from tests.db_data import SessionFactory, add_category, add_product, build_app, update_row
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS


@pytest_asyncio.fixture(loop_scope="module")
async def api(session_factory: SessionFactory) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=build_app(session_factory), raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def products(api: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await api.get("/api/v1/products", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def slugs(page: dict[str, Any]) -> list[str]:
    return [item["slug"] for item in page["items"]]


# --- categories -----------------------------------------------------------------------------------


async def test_categories_tree_is_ordered_at_every_level(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    root_b = await add_category(session_factory, "root-b", sort_order=2, name_uz="B")
    root_a = await add_category(session_factory, "root-a", sort_order=1, name_uz="Z")
    await add_category(session_factory, "child-2", parent=root_a, sort_order=5, name_uz="A")
    await add_category(session_factory, "child-1", parent=root_a, sort_order=5, name_uz="A")
    await add_category(session_factory, "child-0", parent=root_a, sort_order=1, name_uz="Q")
    grand = await add_category(session_factory, "grand", parent=root_b)

    response = await api.get("/api/v1/categories")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"
    items = response.json()["items"]
    assert [node["slug"] for node in items] == ["root-a", "root-b"]
    children = [node["slug"] for node in items[0]["children"]]
    # sort_order, then name_uz, then id (the two "A" siblings are ordered by id).
    tied = sorted(["child-1", "child-2"], key=lambda slug: _id_of(items[0]["children"], slug))
    assert children == ["child-0", *tied]
    assert [node["slug"] for node in items[1]["children"]] == ["grand"]
    assert items[1]["children"][0]["id"] == str(grand.id)
    assert items[1]["children"][0]["children"] == []


def _id_of(nodes: list[dict[str, Any]], slug: str) -> str:
    return str(next(node["id"] for node in nodes if node["slug"] == slug))


async def test_inactive_category_hides_its_whole_subtree(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    visible = await add_category(session_factory, "visible")
    await add_category(session_factory, "visible-child", parent=visible)
    hidden = await add_category(session_factory, "hidden", is_active=False)
    middle = await add_category(session_factory, "hidden-child", parent=hidden)
    await add_category(session_factory, "hidden-grandchild", parent=middle)
    inactive_leaf = await add_category(
        session_factory, "inactive-leaf", parent=visible, is_active=False
    )
    await add_category(session_factory, "under-inactive-leaf", parent=inactive_leaf)

    items = (await api.get("/api/v1/categories")).json()["items"]
    assert [node["slug"] for node in items] == ["visible"]
    assert [node["slug"] for node in items[0]["children"]] == ["visible-child"]


async def test_no_categories(api: httpx.AsyncClient) -> None:
    response = await api.get("/api/v1/categories")
    assert response.json() == {"items": []}


# --- visibility ---------------------------------------------------------------------------------


async def test_only_active_products_in_active_categories_are_listed(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    active = await add_category(session_factory, "active")
    inactive = await add_category(session_factory, "inactive", is_active=False)
    under_inactive = await add_category(session_factory, "under-inactive", parent=inactive)
    child_of_active = await add_category(session_factory, "child-of-active", parent=active)
    await add_product(session_factory, active, "shown")
    await add_product(session_factory, child_of_active, "shown-in-child")
    await add_product(session_factory, active, "inactive-product", is_active=False)
    await add_product(session_factory, inactive, "in-inactive-category")
    await add_product(session_factory, under_inactive, "under-inactive-ancestor")

    page = await products(api)
    assert sorted(slugs(page)) == ["shown", "shown-in-child"]
    assert page["total"] == 2


# --- search -------------------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope="module")
async def searchable(session_factory: SessionFactory) -> Category:
    category = await add_category(session_factory, "search")
    await add_product(
        session_factory,
        category,
        "apple",
        sku="DEMO-0001",
        name_uz="Demo Olma",
        name_ru="Демо Яблоко",
    )
    await add_product(
        session_factory,
        category,
        "banana",
        sku="DEMO-0002",
        name_uz="Demo banan",
        name_ru="Демо банан",
    )
    await add_product(
        session_factory,
        category,
        "inactive-apple",
        sku="DEMO-0003",
        name_uz="Demo olma nofaol",
        name_ru="Демо яблоко неактивно",
        is_active=False,
    )
    return category


async def test_search_matches_uzbek_name_case_insensitively(
    api: httpx.AsyncClient, searchable: Category
) -> None:
    for query in ("olma", "OLMA", "Olm", "lma"):
        assert slugs(await products(api, q=query)) == ["apple"], query


async def test_search_matches_russian_name_case_insensitively(
    api: httpx.AsyncClient, searchable: Category
) -> None:
    for query in ("яблоко", "ЯБЛОКО", "Яблок", "блок"):
        assert slugs(await products(api, q=query)) == ["apple"], query


async def test_search_matches_sku(api: httpx.AsyncClient, searchable: Category) -> None:
    assert slugs(await products(api, q="DEMO-0002")) == ["banana"]
    assert slugs(await products(api, q="demo-0002")) == ["banana"]
    assert slugs(await products(api, q="0001")) == ["apple"]


async def test_search_skips_inactive_products_and_trims(
    api: httpx.AsyncClient, searchable: Category
) -> None:
    # "nofaol" only occurs on the inactive product.
    assert (await products(api, q="nofaol"))["total"] == 0
    assert slugs(await products(api, q="  olma  ")) == ["apple"]


async def test_search_no_match_returns_empty_page(
    api: httpx.AsyncClient, searchable: Category
) -> None:
    page = await products(api, q="zzzz")
    assert (page["items"], page["total"], page["total_pages"]) == ([], 0, 0)


async def test_search_treats_percent_underscore_and_backslash_literally(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    category = await add_category(session_factory, "wild")
    await add_product(session_factory, category, "percent", name_uz="Demo 100% sok")
    await add_product(session_factory, category, "plain", name_uz="Demo 1000 sok")
    await add_product(session_factory, category, "under", name_uz="Demo a_b mix")
    await add_product(session_factory, category, "other", name_uz="Demo axb mix")
    await add_product(session_factory, category, "slash", name_uz="Demo c\\d mix")
    await add_product(session_factory, category, "slashless", name_uz="Demo cXd mix")

    assert slugs(await products(api, q="0% s")) == ["percent"]
    assert slugs(await products(api, q="a_b")) == ["under"]
    assert slugs(await products(api, q="c\\d")) == ["slash"]
    # A bare wildcard must not match everything.
    assert (await products(api, q="%%"))["total"] == 0
    assert (await products(api, q="__"))["total"] == 0
    assert (await products(api, q="\\\\"))["total"] == 0


async def test_search_combines_with_category_filter(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    fruit = await add_category(session_factory, "fruit")
    drinks = await add_category(session_factory, "drinks")
    await add_product(session_factory, fruit, "apple", name_uz="Demo olma")
    await add_product(session_factory, drinks, "apple-juice", name_uz="Demo olma sharbati")
    assert sorted(slugs(await products(api, q="olma"))) == ["apple", "apple-juice"]
    assert slugs(await products(api, q="olma", category="drinks")) == ["apple-juice"]


# --- category filter ----------------------------------------------------------------------------


async def test_category_filter_includes_active_descendants(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    root = await add_category(session_factory, "root")
    child = await add_category(session_factory, "child", parent=root)
    grandchild = await add_category(session_factory, "grandchild", parent=child)
    sibling = await add_category(session_factory, "sibling", parent=root)
    other = await add_category(session_factory, "other")
    inactive_child = await add_category(
        session_factory, "inactive-child", parent=root, is_active=False
    )
    under_inactive = await add_category(session_factory, "under-inactive", parent=inactive_child)
    await add_product(session_factory, root, "in-root")
    await add_product(session_factory, child, "in-child")
    await add_product(session_factory, grandchild, "in-grandchild")
    await add_product(session_factory, sibling, "in-sibling")
    await add_product(session_factory, other, "in-other")
    await add_product(session_factory, inactive_child, "in-inactive-child")
    await add_product(session_factory, under_inactive, "in-under-inactive")

    assert sorted(slugs(await products(api, category="root"))) == [
        "in-child",
        "in-grandchild",
        "in-root",
        "in-sibling",
    ]
    assert sorted(slugs(await products(api, category="child"))) == ["in-child", "in-grandchild"]
    assert slugs(await products(api, category="grandchild")) == ["in-grandchild"]
    assert slugs(await products(api, category="other")) == ["in-other"]


async def test_category_without_products_is_an_empty_page(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    await add_category(session_factory, "empty")
    page = await products(api, category="empty")
    assert (page["items"], page["total"], page["total_pages"]) == ([], 0, 0)


async def test_unknown_or_hidden_category_is_404(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    inactive = await add_category(session_factory, "inactive", is_active=False)
    await add_category(session_factory, "under-inactive", parent=inactive)
    for slug in ("missing", "inactive", "under-inactive"):
        response = await api.get("/api/v1/products", params={"category": slug})
        assert response.status_code == 404, slug
        assert response.json()["error"]["code"] == "category_not_found"


# --- pagination and sorting -----------------------------------------------------------------------


async def test_pagination_totals_and_pages(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    category = await add_category(session_factory, "paged")
    for index in range(7):
        await add_product(session_factory, category, f"p{index}", price=1_000 * (index + 1))

    seen: list[str] = []
    for page_number, expected_size in ((1, 3), (2, 3), (3, 1)):
        page = await products(api, sort="price_asc", page=page_number, page_size=3)
        assert (page["page"], page["page_size"], page["total"], page["total_pages"]) == (
            page_number,
            3,
            7,
            3,
        )
        assert len(page["items"]) == expected_size
        seen += slugs(page)
    assert seen == [f"p{index}" for index in range(7)]

    beyond = await products(api, sort="price_asc", page=4, page_size=3)
    assert (beyond["items"], beyond["total"], beyond["total_pages"]) == ([], 7, 3)

    exact = await products(api, page_size=7)
    assert (len(exact["items"]), exact["total_pages"]) == (7, 1)
    default = await products(api)
    assert (default["page"], default["page_size"]) == (1, 24)


async def test_sort_orders(api: httpx.AsyncClient, session_factory: SessionFactory) -> None:
    category = await add_category(session_factory, "sorted")
    day = datetime(2026, 1, 1, tzinfo=UTC)
    await add_product(session_factory, category, "b", price=30_000, name_uz="Beta", created_at=day)
    await add_product(
        session_factory, category, "a", price=10_000, name_uz="Alpha", created_at=day.replace(day=3)
    )
    await add_product(
        session_factory, category, "c", price=20_000, name_uz="Gamma", created_at=day.replace(day=2)
    )

    assert slugs(await products(api)) == ["a", "c", "b"]  # newest is the default
    assert slugs(await products(api, sort="newest")) == ["a", "c", "b"]
    assert slugs(await products(api, sort="price_asc")) == ["a", "c", "b"]
    assert slugs(await products(api, sort="price_desc")) == ["b", "c", "a"]
    assert slugs(await products(api, sort="name")) == ["a", "b", "c"]


@pytest.mark.parametrize(
    ("sort", "descending_ids"),
    [("newest", True), ("price_asc", False), ("price_desc", False), ("name", False)],
)
async def test_equal_keys_are_ordered_by_id_so_pages_never_overlap(
    api: httpx.AsyncClient,
    session_factory: SessionFactory,
    sort: str,
    descending_ids: bool,
) -> None:
    category = await add_category(session_factory, "ties")
    moment = datetime(2026, 5, 5, 12, 0, tzinfo=UTC)
    created: list[Product] = [
        await add_product(
            session_factory,
            category,
            f"tie-{index}",
            price=15_000,
            name_uz="Demo bir xil",
            created_at=moment,
        )
        for index in range(10)
    ]
    expected = [
        product.slug
        for product in sorted(created, key=lambda product: product.id, reverse=descending_ids)
    ]

    collected: list[str] = []
    for page_number in range(1, 5):
        page = await products(api, sort=sort, page=page_number, page_size=3)
        collected += slugs(page)
    assert collected == expected
    assert len(set(collected)) == 10


# --- product detail -------------------------------------------------------------------------------


async def test_product_detail(api: httpx.AsyncClient, session_factory: SessionFactory) -> None:
    category = await add_category(session_factory, "detail-cat")
    product = await add_product(
        session_factory,
        category,
        "detail",
        sku="DEMO-9001",
        price=25_000,
        old_price=30_000,
        stock=4,
        description_uz="Tavsif",
        description_ru="Описание",
        brand="Demo",
        image_url=None,
    )
    response = await api.get("/api/v1/products/detail")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"
    body = response.json()
    assert body["id"] == str(product.id)
    assert (body["sku"], body["price_uzs"], body["old_price_uzs"]) == ("DEMO-9001", 25_000, 30_000)
    assert (body["stock_quantity"], body["in_stock"], body["unit"]) == (4, True, "piece")
    assert (body["description_uz"], body["description_ru"], body["brand"]) == (
        "Tavsif",
        "Описание",
        "Demo",
    )
    assert body["image_url"] is None
    assert body["category"] == {
        "id": str(category.id),
        "slug": "detail-cat",
        "name_uz": "Demo detail-cat",
        "name_ru": "Демо detail-cat",
    }
    assert body["category_id"] == str(category.id)


async def test_stock_flags(api: httpx.AsyncClient, session_factory: SessionFactory) -> None:
    category = await add_category(session_factory, "stock-cat")
    await add_product(session_factory, category, "tracked", stock=2)
    await add_product(session_factory, category, "empty", stock=0)
    await add_product(session_factory, category, "untracked", stock=None)
    by_slug = {item["slug"]: item for item in (await products(api))["items"]}
    assert (by_slug["tracked"]["stock_quantity"], by_slug["tracked"]["in_stock"]) == (2, True)
    assert (by_slug["empty"]["stock_quantity"], by_slug["empty"]["in_stock"]) == (0, False)
    assert (by_slug["untracked"]["stock_quantity"], by_slug["untracked"]["in_stock"]) == (
        None,
        True,
    )


async def test_product_detail_404s(api: httpx.AsyncClient, session_factory: SessionFactory) -> None:
    active = await add_category(session_factory, "d-active")
    inactive = await add_category(session_factory, "d-inactive", is_active=False)
    under_inactive = await add_category(session_factory, "d-under", parent=inactive)
    await add_product(session_factory, active, "inactive-product", is_active=False)
    await add_product(session_factory, inactive, "in-inactive-category")
    await add_product(session_factory, under_inactive, "under-inactive-ancestor")

    for slug in (
        "does-not-exist",
        "inactive-product",
        "in-inactive-category",
        "under-inactive-ancestor",
    ):
        response = await api.get(f"/api/v1/products/{slug}")
        assert response.status_code == 404, slug
        assert response.json()["error"]["code"] == "product_not_found"


async def test_visibility_follows_later_changes(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    category = await add_category(session_factory, "toggle")
    product = await add_product(session_factory, category, "toggled")
    assert (await api.get("/api/v1/products/toggled")).status_code == 200

    await update_row(session_factory, Category, category.id, is_active=False)
    assert (await api.get("/api/v1/products/toggled")).status_code == 404
    assert (await products(api))["total"] == 0

    await update_row(session_factory, Category, category.id, is_active=True)
    await update_row(session_factory, Product, product.id, is_active=False)
    assert (await api.get("/api/v1/products/toggled")).status_code == 404

    await update_row(session_factory, Product, product.id, is_active=True)
    assert (await api.get("/api/v1/products/toggled")).status_code == 200


async def test_unused_slug_is_a_plain_404_envelope(api: httpx.AsyncClient) -> None:
    response = await api.get(f"/api/v1/products/{uuid.uuid4().hex}")
    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "product_not_found", "message": "Product not found"}
    }


# --- dev seed -------------------------------------------------------------------------------------


async def test_seed_is_idempotent_and_shows_the_expected_catalog(
    api: httpx.AsyncClient, session_factory: SessionFactory
) -> None:
    first = await seed(session_factory)
    assert first.categories_written == len(DEMO_CATEGORIES)
    assert first.products_written == len(DEMO_PRODUCTS)

    second = await seed(session_factory)
    assert (second.categories_written, second.products_written) == (0, 0)

    tree = (await api.get("/api/v1/categories")).json()["items"]
    assert [node["slug"] for node in tree] == [
        "demo-mevalar-sabzavotlar",
        "demo-ichimliklar",
        "demo-sut",
    ]
    assert [child["slug"] for child in tree[0]["children"]] == ["demo-mevalar", "demo-sabzavotlar"]

    page = await products(api, page_size=48)
    # One inactive product and one product under an inactive category are hidden.
    assert page["total"] == len(DEMO_PRODUCTS) - 2
    assert all(item["image_url"] is None for item in page["items"])
    assert all(item["sku"].startswith("DEMO-") for item in page["items"])
    assert "demo-eski-mahsulot" not in slugs(page)
    assert "demo-arxiv-mahsulot" not in slugs(page)
    out_of_stock = next(item for item in page["items"] if item["slug"] == "demo-shaftoli-sharbati")
    assert (out_of_stock["stock_quantity"], out_of_stock["in_stock"]) == (0, False)
    fruit = await products(api, category="demo-mevalar-sabzavotlar", page_size=48)
    assert fruit["total"] == 6
