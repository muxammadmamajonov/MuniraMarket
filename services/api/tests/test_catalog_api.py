"""Catalog routes against a fake repository (no database)."""

from typing import cast

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis

from app.api.routes.catalog import get_catalog_repository
from app.repositories.catalog import (
    CategoryNodeRecord,
    CategoryNotFoundError,
    ProductDetailRecord,
    ProductPageRecord,
    ProductSort,
)
from app.security.rate_limit import RedisRateLimiter
from tests.auth_helpers import FakeRedis
from tests.catalog_factories import make_category, make_detail, make_product
from tests.conftest import FakeClock

CACHE_CONTROL = "public, max-age=60"


class FakeCatalogRepository:
    def __init__(self) -> None:
        self.tree: list[CategoryNodeRecord] = []
        self.page = ProductPageRecord(items=(), total=0)
        self.detail: ProductDetailRecord | None = None
        self.unknown_category = False
        self.calls: list[dict[str, object]] = []

    async def list_category_tree(self) -> list[CategoryNodeRecord]:
        return self.tree

    async def list_products(
        self,
        *,
        category_slug: str | None,
        query: str | None,
        sort: ProductSort,
        page: int,
        page_size: int,
    ) -> ProductPageRecord:
        self.calls.append(
            {
                "category_slug": category_slug,
                "query": query,
                "sort": sort,
                "page": page,
                "page_size": page_size,
            }
        )
        if self.unknown_category:
            raise CategoryNotFoundError(category_slug)
        return self.page

    async def get_product_by_slug(self, slug: str) -> ProductDetailRecord | None:
        return self.detail


@pytest.fixture
def catalog(app: FastAPI) -> FakeCatalogRepository:
    repository = FakeCatalogRepository()
    app.dependency_overrides[get_catalog_repository] = lambda: repository
    return repository


# --- GET /categories ----------------------------------------------------------------------------


async def test_categories_tree_shape(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    child = make_category("demo-fruit", sort_order=1)
    catalog.tree = [make_category("demo-food", children=(child,)), make_category("demo-drinks")]
    response = await client.get("/api/v1/categories")
    assert response.status_code == 200
    assert response.headers["cache-control"] == CACHE_CONTROL
    items = response.json()["items"]
    assert [node["slug"] for node in items] == ["demo-food", "demo-drinks"]
    assert set(items[0]) == {
        "id",
        "slug",
        "name_uz",
        "name_ru",
        "image_url",
        "sort_order",
        "children",
    }
    assert items[0]["children"][0]["slug"] == "demo-fruit"
    assert items[0]["children"][0]["children"] == []
    assert items[0]["children"][0]["image_url"] is None


async def test_catalog_needs_no_session(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    # get_current_user is an unimplemented stub in the base app: any use would raise.
    assert (await client.get("/api/v1/categories")).status_code == 200
    assert (await client.get("/api/v1/products")).status_code == 200


# --- per-IP rate limit ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path", ["/api/v1/categories", "/api/v1/products", "/api/v1/products/demo-apple"]
)
async def test_catalog_ip_limit_is_not_cached(
    app: FastAPI, client: httpx.AsyncClient, catalog: FakeCatalogRepository, path: str
) -> None:
    catalog.detail = make_detail()
    looked_up: list[bool] = []

    def repository() -> FakeCatalogRepository:
        looked_up.append(True)
        return catalog

    app.dependency_overrides[get_catalog_repository] = repository
    for _ in range(300):
        assert (await client.get(path)).headers["cache-control"] == CACHE_CONTROL
    looked_up.clear()
    response = await client.get(path)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"
    assert response.headers["cache-control"] == "no-store"  # never "public"
    assert int(response.headers["retry-after"]) >= 1
    assert looked_up == []  # rejected before the database session is opened
    assert any(
        key.startswith("mm:rl:catalog_ip:127.0.0.1:") for key in app.state.rate_limiter._counters
    )


async def test_catalog_limiter_outage_fails_closed(
    app: FastAPI, client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    app.state.rate_limiter = RedisRateLimiter(cast("Redis", FakeRedis(fail=True)), FakeClock())
    response = await client.get("/api/v1/products")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
    assert catalog.calls == []


# --- GET /products ------------------------------------------------------------------------------


async def test_products_defaults_and_page_shape(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    catalog.page = ProductPageRecord(
        items=(
            make_product(slug="a", stock_quantity=0, old_price_uzs=15_000),
            make_product(slug="b", stock_quantity=4),
            make_product(slug="c", stock_quantity=None),
        ),
        total=101,
    )
    response = await client.get("/api/v1/products")
    assert response.status_code == 200
    assert response.headers["cache-control"] == CACHE_CONTROL
    assert catalog.calls == [
        {
            "category_slug": None,
            "query": None,
            "sort": ProductSort.NEWEST,
            "page": 1,
            "page_size": 24,
        }
    ]
    body = response.json()
    assert (body["page"], body["page_size"], body["total"], body["total_pages"]) == (1, 24, 101, 5)
    first, second, third = body["items"]
    assert set(first) == {
        "id",
        "slug",
        "sku",
        "name_uz",
        "name_ru",
        "unit",
        "price_uzs",
        "old_price_uzs",
        "stock_quantity",
        "in_stock",
        "image_url",
        "category_id",
    }
    assert first["unit"] == "kg"
    assert first["old_price_uzs"] == 15_000
    assert (first["stock_quantity"], first["in_stock"]) == (0, False)
    assert (second["stock_quantity"], second["in_stock"]) == (4, True)
    assert (third["stock_quantity"], third["in_stock"]) == (None, True)


async def test_products_passes_filters_to_repository(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    response = await client.get(
        "/api/v1/products",
        params={
            "category": "demo-fruit",
            "q": "  olma  ",
            "sort": "price_desc",
            "page": 3,
            "page_size": 48,
        },
    )
    assert response.status_code == 200
    assert catalog.calls == [
        {
            "category_slug": "demo-fruit",
            "query": "olma",  # trimmed
            "sort": ProductSort.PRICE_DESC,
            "page": 3,
            "page_size": 48,
        }
    ]
    body = response.json()
    assert (body["items"], body["total"], body["total_pages"]) == ([], 0, 0)


@pytest.mark.parametrize("sort", ["newest", "price_asc", "price_desc", "name"])
async def test_products_accepts_every_sort(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository, sort: str
) -> None:
    assert (await client.get("/api/v1/products", params={"sort": sort})).status_code == 200
    assert catalog.calls[-1]["sort"] == ProductSort(sort)


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},
        {"page": -1},
        {"page": "x"},
        {"page_size": 0},
        {"page_size": 49},
        {"sort": "cheapest"},
        {"q": "a"},
        {"q": " a "},
        {"q": ""},
        {"q": "   "},
        {"q": "x" * 101},
        {"category": ""},
    ],
)
async def test_products_rejects_bad_parameters(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository, params: dict[str, str | int]
) -> None:
    response = await client.get("/api/v1/products", params=params)
    assert response.status_code == 422, params
    assert response.json()["error"]["code"] == "validation_error"
    assert catalog.calls == []


async def test_products_query_bounds_are_inclusive(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    assert (await client.get("/api/v1/products", params={"q": "ab"})).status_code == 200
    assert (await client.get("/api/v1/products", params={"q": "x" * 100})).status_code == 200
    assert (await client.get("/api/v1/products", params={"page_size": 1})).status_code == 200
    assert (await client.get("/api/v1/products", params={"page_size": 48})).status_code == 200


async def test_products_unknown_category_is_404(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    catalog.unknown_category = True
    response = await client.get("/api/v1/products", params={"category": "nope"})
    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "category_not_found", "message": "Category not found"}
    }


# --- GET /products/{slug} -------------------------------------------------------------------------


async def test_product_detail_shape(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    catalog.detail = make_detail(make_product(slug="demo-apple", stock_quantity=3))
    response = await client.get("/api/v1/products/demo-apple")
    assert response.status_code == 200
    assert response.headers["cache-control"] == CACHE_CONTROL
    body = response.json()
    assert body["slug"] == "demo-apple"
    assert body["in_stock"] is True
    assert body["description_uz"] == "Demo tavsif"
    assert body["description_ru"] == "Демо описание"
    assert body["brand"] == "Demo"
    assert set(body["category"]) == {"id", "slug", "name_uz", "name_ru"}
    assert body["category"]["id"] == body["category_id"]


async def test_product_detail_missing_is_404(
    client: httpx.AsyncClient, catalog: FakeCatalogRepository
) -> None:
    response = await client.get("/api/v1/products/nope")
    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "product_not_found", "message": "Product not found"}
    }
    assert "cache-control" not in response.headers


# --- OpenAPI --------------------------------------------------------------------------------------


async def test_openapi_documents_catalog(client: httpx.AsyncClient) -> None:
    spec = (await client.get("/api/v1/openapi.json")).json()
    paths = spec["paths"]
    for path in ("/api/v1/categories", "/api/v1/products", "/api/v1/products/{slug}"):
        assert "get" in paths[path]
    ok = paths["/api/v1/products"]["get"]["responses"]
    assert ok["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/ProductPage")
    for status in ("404", "422"):
        assert ok[status]["content"]["application/json"]["schema"]["$ref"].endswith(
            "/ErrorEnvelope"
        )
    detail = paths["/api/v1/products/{slug}"]["get"]["responses"]
    assert detail["404"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorEnvelope")
    parameters = {p["name"]: p for p in paths["/api/v1/products"]["get"]["parameters"]}
    assert parameters["page_size"]["schema"]["maximum"] == 48
    assert parameters["page_size"]["schema"]["default"] == 24
    assert parameters["page"]["schema"]["minimum"] == 1
    assert {"newest", "price_asc", "price_desc", "name"} == set(
        spec["components"]["schemas"]["ProductSort"]["enum"]
    )
