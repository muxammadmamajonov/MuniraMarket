"""Admin catalog and CSV routes against a recording fake repository (no database).

Access control is checked for every route: operators, customers, Mini App sessions and
anonymous callers are refused before the repository is touched, for unknown ids too. The real
session/CSRF wiring is exercised once end to end with in-memory sessions.
"""

import dataclasses
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api import admin_deps, auth_deps
from app.api.routes import admin_catalog, admin_csv
from app.core.errors import ApiError
from app.domain.catalog_csv import BOM, COLUMNS, CsvRowError, ExportRow
from app.models.enums import Unit, UserRole
from app.repositories.admin_catalog import (
    AdminCatalogError,
    AdminProductPageRecord,
    CategoryCycleError,
    CategoryNotEmptyError,
    CategoryNotFoundError,
    CsvImportOutcome,
    InvalidOldPriceError,
    ProductArchivedError,
    ProductNotFoundError,
    ProductStatusFilter,
    ReferencedCategoryNotFoundError,
    SkuTakenError,
    SlugTakenError,
)
from tests.admin_factories import (
    ADMIN_LIMITS,
    CATALOG_ROUTES,
    CSV_HEADERS,
    CSV_ROUTES,
    RecordingRepository,
    Route,
    error_of,
    make_category_record,
    make_product_record,
)
from tests.auth_helpers import TRUSTED_ORIGIN, build_app, cookie_header, http_client, login
from tests.catalog_factories import make_user
from tests.conftest import FakeClock, FakeUserRepository

CATEGORIES = "/api/v1/admin/categories"
PRODUCTS = "/api/v1/admin/products"
CSV = "/api/v1/admin/catalog/csv"
PRODUCT_ID = uuid.uuid4()
CATEGORY_ID = uuid.uuid4()
ROUTES = (*CATALOG_ROUTES, *CSV_ROUTES)
WRITES = tuple(route for route in ROUTES if route.is_write)


async def _allow() -> None:
    return None


def _raiser(error: ApiError) -> Any:
    async def dependency() -> None:
        raise error

    return dependency


def _outcome(**overrides: Any) -> CsvImportOutcome:
    values: dict[str, Any] = {
        "dry_run": False,
        "applied": True,
        "total_rows": 1,
        "creates": 1,
        "updates": 0,
        "unchanged": 0,
        "errors": (),
        "errors_truncated": False,
    }
    values.update(overrides)
    return CsvImportOutcome(**values)


@pytest.fixture
def catalog(app: FastAPI) -> RecordingRepository:
    repository = RecordingRepository(
        list_categories=[make_category_record()],
        create_category=make_category_record(),
        update_category=make_category_record(),
        delete_category=None,
        list_products=AdminProductPageRecord(items=(make_product_record(),), total=41),
        get_product=make_product_record(id=PRODUCT_ID),
        create_product=make_product_record(),
        update_product=make_product_record(),
        archive_product=make_product_record(is_active=False),
        restore_product=make_product_record(is_active=False),
        export_rows=[],
        import_csv=_outcome(),
    )
    app.dependency_overrides[admin_catalog.get_admin_catalog_repository] = lambda: repository
    app.dependency_overrides[auth_deps.require_csrf] = _allow
    app.dependency_overrides[admin_deps.require_back_office_session] = _allow
    for limit in ADMIN_LIMITS:
        app.dependency_overrides[limit] = _allow
    as_role(app, UserRole.ADMIN)
    return repository


def as_role(app: FastAPI, role: UserRole) -> Any:
    user = make_user(role=role)
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    return user


# --- access control ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES, ids=str)
@pytest.mark.parametrize("role", [UserRole.OPERATOR, UserRole.CUSTOMER])
async def test_only_admins(
    app: FastAPI,
    client: httpx.AsyncClient,
    catalog: RecordingRepository,
    route: Route,
    role: UserRole,
) -> None:
    as_role(app, role)
    response = await route.send(client)
    assert response.json() == {"error": {"code": "forbidden", "message": "Admin role required"}}
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert catalog.calls == []


@pytest.mark.parametrize("route", ROUTES, ids=str)
async def test_anonymous_is_401(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository, route: Route
) -> None:
    app.dependency_overrides[auth_deps.get_current_user] = _raiser(
        ApiError(401, "session_required", "Sign-in required")
    )
    error_of(await route.send(client), 401, "session_required")
    assert catalog.calls == []


@pytest.mark.parametrize("route", WRITES, ids=str)
async def test_writes_require_csrf(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository, route: Route
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF validation failed")
    )
    error_of(await route.send(client), 403, "csrf_failed")
    assert catalog.calls == []


async def test_reads_do_not_need_csrf(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF validation failed")
    )
    for route in ROUTES:
        if not route.is_write:
            assert (await route.send(client)).status_code != 403, route


async def test_ip_limit_runs_before_the_session_lookup(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    looked_up: list[bool] = []

    async def current_user() -> None:
        looked_up.append(True)
        raise ApiError(401, "session_required", "Sign-in required")

    app.dependency_overrides[auth_deps.get_current_user] = current_user
    app.dependency_overrides[admin_deps.ADMIN_IP_LIMIT] = _raiser(
        ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "3"})
    )
    for route in ROUTES:
        error_of(await route.send(client), 429, "rate_limited")
    assert looked_up == []


async def test_real_sessions_mini_app_session_is_refused(clock: FakeClock) -> None:
    """End to end with real sessions: an admin's Mini App (initData) session is a storefront
    session and gets 403; the same admin's Login Widget session gets in, and writes need the
    CSRF token."""
    users = FakeUserRepository()
    app = build_app(clock, users)
    repository = RecordingRepository(
        list_categories=[], update_product=make_product_record(), import_csv=_outcome()
    )
    app.dependency_overrides[admin_catalog.get_admin_catalog_repository] = lambda: repository
    async with http_client(app) as client:
        for route in ROUTES:
            error_of(await route.send(client), 401, "session_required")
        signed_in = await login(client, clock)
        [record] = users.users.values()
        users.users[record.telegram_user_id] = dataclasses.replace(record, role=UserRole.ADMIN)
        mini_app = {
            **cookie_header(signed_in.token),
            "Origin": TRUSTED_ORIGIN,
            "X-CSRF-Token": signed_in.csrf_token,
        }
        for route in ROUTES:
            error_of(await route.send(client, mini_app), 403, "forbidden")
        assert repository.calls == []

        widget = await app.state.session_manager.create(
            user_id=record.id,
            telegram_user_id=record.telegram_user_id,
            auth_method="telegram_login_widget",
        )
        session = cookie_header(widget.token)
        csrf = {**session, "Origin": TRUSTED_ORIGIN, "X-CSRF-Token": widget.data.csrf_token}
        assert (await client.get(CATEGORIES, headers=session)).status_code == 200
        patch = Route("PATCH", f"{PRODUCTS}/{PRODUCT_ID}", json={"price_uzs": 1})
        error_of(await patch.send(client, session), 403, "csrf_failed")
        error_of(await patch.send(client, {**csrf, "X-CSRF-Token": "wrong"}), 403, "csrf_failed")
        assert (await patch.send(client, csrf)).status_code == 200
        csv_import = CSV_ROUTES[-1]
        error_of(await csv_import.send(client, session), 403, "csrf_failed")
        assert (await csv_import.send(client, csrf)).status_code != 403

        # Demoted: the role is re-read on the very next request.
        users.users[record.telegram_user_id] = dataclasses.replace(record, role=UserRole.OPERATOR)
        error_of(await client.get(CATEGORIES, headers=session), 403, "forbidden")


# --- categories -------------------------------------------------------------------------------


async def test_list_categories(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.get(CATEGORIES)
    assert response.status_code == 200
    [item] = response.json()["items"]
    assert item["product_count"] == 0
    assert item["child_count"] == 0


async def test_create_category(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.post(
        CATEGORIES,
        json={
            "slug": " sut-mahsulotlari ",
            "name_uz": " Sut mahsulotlari ",
            "name_ru": "Молочные продукты",
            "parent_id": str(CATEGORY_ID),
            "image_url": "",
        },
    )
    assert response.status_code == 201, response.text
    name, _, kwargs = catalog.last()
    assert name == "create_category"
    values = catalog.calls[-1][1][0]
    assert values == {
        "slug": "sut-mahsulotlari",
        "name_uz": "Sut mahsulotlari",
        "name_ru": "Молочные продукты",
        "parent_id": CATEGORY_ID,
        "image_url": None,
        "sort_order": 0,
        "is_active": True,
    }
    assert kwargs["actor"].role is UserRole.ADMIN


async def test_patch_category_sends_only_given_fields(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    response = await client.patch(f"{CATEGORIES}/{CATEGORY_ID}", json={"parent_id": None})
    assert response.status_code == 200
    _, args, _ = catalog.last()
    assert args == (CATEGORY_ID, {"parent_id": None})


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"slug": "Bad Slug"},
        {"slug": "a" * 129},
        {"slug": None},
        {"name_uz": None},
        {"name_uz": ""},
        {"name_uz": "two\nlines"},
        {"sort_order": 100_001},
        {"image_url": "http://cdn.example.com/a.png"},
        {"image_url": "https://192.168.1.1/a.png"},
        {"unknown": 1},
    ],
)
async def test_patch_category_validation(
    client: httpx.AsyncClient, catalog: RecordingRepository, body: dict[str, Any]
) -> None:
    error_of(await client.patch(f"{CATEGORIES}/{CATEGORY_ID}", json=body), 422, "validation_error")
    assert catalog.calls == []


async def test_delete_category(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.delete(f"{CATEGORIES}/{CATEGORY_ID}")
    assert response.status_code == 204
    assert response.content == b""


# --- products ---------------------------------------------------------------------------------


def product_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "sku": "DEMO-0001",
        "slug": "demo-olma",
        "category_id": str(CATEGORY_ID),
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "unit": "kg",
        "price_uzs": 12_000,
    }
    body.update(overrides)
    return body


async def test_create_product(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.post(
        PRODUCTS,
        json=product_body(
            description_uz="  Bir\r\nIkki\tuch  ",
            description_ru="   ",
            old_price_uzs=15_000,
            stock_quantity=0,
            image_url="https://cdn.example.com/olma.webp",
        ),
    )
    assert response.status_code == 201, response.text
    values = catalog.last()[1][0]
    assert values["description_uz"] == "Bir\nIkki\tuch"
    assert values["description_ru"] is None
    assert values["unit"] is Unit.KG
    assert values["stock_quantity"] == 0
    assert values["is_active"] is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"sku": "-bad"},
        {"sku": "x" * 65},
        {"slug": "Upper"},
        {"price_uzs": -1},
        {"price_uzs": 10**12 + 1},
        {"price_uzs": 1.5},
        {"old_price_uzs": 12_000},
        {"old_price_uzs": 100},
        {"stock_quantity": -1},
        {"stock_quantity": 1_000_001},
        {"sort_order": -100_001},
        {"unit": "box"},
        {"name_ru": "x" * 256},
        {"description_uz": "x" * 5001},
        {"description_uz": "bad\x00"},
        {"image_url": "javascript:alert(1)"},
        {"image_url": "https://localhost/a.png"},
        {"archived_at": "2026-01-01T00:00:00Z"},
        {"id": str(uuid.uuid4())},
    ],
)
async def test_create_product_validation(
    client: httpx.AsyncClient, catalog: RecordingRepository, overrides: dict[str, Any]
) -> None:
    error_of(await client.post(PRODUCTS, json=product_body(**overrides)), 422, "validation_error")
    assert catalog.calls == []


async def test_patch_product_only_changes_sent_fields(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    response = await client.patch(
        f"{PRODUCTS}/{PRODUCT_ID}",
        json={"price_uzs": 9_000, "stock_quantity": None, "old_price_uzs": None},
    )
    assert response.status_code == 200
    _, args, _ = catalog.last()
    assert args == (PRODUCT_ID, {"price_uzs": 9_000, "stock_quantity": None, "old_price_uzs": None})


@pytest.mark.parametrize(
    "body",
    [{}, {"price_uzs": None}, {"sku": None}, {"is_active": None}, {"unit": None}, {"x": 1}],
)
async def test_patch_product_validation(
    client: httpx.AsyncClient, catalog: RecordingRepository, body: dict[str, Any]
) -> None:
    error_of(await client.patch(f"{PRODUCTS}/{PRODUCT_ID}", json=body), 422, "validation_error")
    assert catalog.calls == []


async def test_list_products_passes_filters(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    response = await client.get(
        PRODUCTS,
        params={
            "q": "  olma ",
            "category_id": str(CATEGORY_ID),
            "status": "archived",
            "page": 2,
            "page_size": 20,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["total_pages"], body["page"]) == (41, 3, 2)
    assert catalog.last()[2] == {
        "query": "olma",
        "category_id": CATEGORY_ID,
        "status": ProductStatusFilter.ARCHIVED,
        "page": 2,
        "page_size": 20,
    }
    await client.get(PRODUCTS, params={"q": "   "})
    assert catalog.last()[2]["query"] is None
    assert catalog.last()[2]["status"] is None


@pytest.mark.parametrize(
    "params",
    [{"page_size": 101}, {"page": 0}, {"status": "deleted"}, {"q": "x" * 101}],
)
async def test_list_products_bounds(
    client: httpx.AsyncClient, catalog: RecordingRepository, params: dict[str, Any]
) -> None:
    error_of(await client.get(PRODUCTS, params=params), 422, "validation_error")


async def test_unknown_product_is_404(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    catalog.results["get_product"] = None
    error_of(await client.get(f"{PRODUCTS}/{uuid.uuid4()}"), 404, "product_not_found")


async def test_archive_and_restore(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.delete(f"{PRODUCTS}/{PRODUCT_ID}")
    assert response.status_code == 200
    assert response.json()["is_active"] is False
    assert catalog.last()[0] == "archive_product"
    assert (await client.post(f"{PRODUCTS}/{PRODUCT_ID}/restore")).status_code == 200
    assert catalog.last()[0] == "restore_product"


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (CategoryNotFoundError(), 404, "category_not_found"),
        (ProductNotFoundError(), 404, "product_not_found"),
        (ReferencedCategoryNotFoundError("category_id"), 422, "category_not_found"),
        (InvalidOldPriceError(), 422, "validation_error"),
        (CategoryCycleError(), 409, "category_cycle"),
        (CategoryNotEmptyError(), 409, "category_not_empty"),
        (SlugTakenError(), 409, "slug_taken"),
        (SkuTakenError(), 409, "sku_taken"),
        (ProductArchivedError(), 409, "product_archived"),
    ],
)
async def test_error_mapping(
    client: httpx.AsyncClient,
    catalog: RecordingRepository,
    error: AdminCatalogError,
    status: int,
    code: str,
) -> None:
    catalog.error = error
    body = error_of(
        await client.patch(f"{PRODUCTS}/{PRODUCT_ID}", json={"price_uzs": 1}), status, code
    )
    if isinstance(error, ReferencedCategoryNotFoundError):
        assert body["details"] == [{"loc": ["body", "category_id"], "msg": "Category not found"}]


# --- CSV --------------------------------------------------------------------------------------


async def test_template(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    response = await client.get(f"{CSV}/template")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="catalog-template.csv"'
    assert response.headers["cache-control"] == "no-store"
    assert response.content == (BOM + ",".join(COLUMNS) + "\r\n").encode()


async def test_export(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    catalog.results["export_rows"] = [
        ExportRow(
            sku="DEMO-1",
            slug="demo-1",
            category_slug="mevalar",
            name_uz='=HYPERLINK("https://evil.example")',
            name_ru="Демо",
            description_uz=None,
            description_ru=None,
            unit=Unit.PIECE,
            price_uzs=1000,
            old_price_uzs=None,
            stock_quantity=None,
            is_active=True,
            sort_order=0,
            image_url=None,
        )
    ]
    response = await client.get(f"{CSV}/export")
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith('attachment; filename="catalog-')
    assert response.headers["cache-control"] == "no-store"
    text = response.content.decode("utf-8")
    assert text.startswith(BOM)
    assert '"\'=HYPERLINK(""https://evil.example"")"' in text


@pytest.mark.parametrize("content_type", [None, "application/json", "text/plain"])
async def test_import_needs_text_csv(
    client: httpx.AsyncClient, catalog: RecordingRepository, content_type: str | None
) -> None:
    headers = {} if content_type is None else {"Content-Type": content_type}
    response = await client.post(f"{CSV}/import", content=b"sku\r\n", headers=headers)
    error_of(response, 415, "unsupported_media_type")
    assert catalog.calls == []


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("sku,slug\r\n".encode("utf-16"), "csv_invalid_encoding"),
        ("Название\r\n".encode("cp1251"), "csv_invalid_encoding"),
        (b"sku,price\r\n", "csv_invalid_header"),
        ((",".join(COLUMNS) + '\r\n"open\r\n').encode(), "csv_malformed"),
        (
            (",".join(COLUMNS) + "\r\n" + ("x," * 13 + "x\r\n") * 2001).encode(),
            "csv_too_many_rows",
        ),
    ],
)
async def test_import_file_errors(
    client: httpx.AsyncClient, catalog: RecordingRepository, raw: bytes, code: str
) -> None:
    response = await client.post(f"{CSV}/import", content=raw, headers=CSV_HEADERS)
    body = error_of(response, 422, code)
    if code == "csv_invalid_header":
        assert {"loc": ["body", "unknown"], "msg": "price"} in body["details"]
        assert {"loc": ["body", "missing"], "msg": "name_uz"} in body["details"]
    assert catalog.calls == []


async def test_import_body_over_1_mib_is_413(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    raw = b"x" * (1024 * 1024 + 1)
    error_of(
        await client.post(f"{CSV}/import", content=raw, headers=CSV_HEADERS),
        413,
        "payload_too_large",
    )

    async def chunks() -> Any:
        for _ in range(17):
            yield b"y" * (64 * 1024)

    error_of(
        await client.post(f"{CSV}/import", content=chunks(), headers=CSV_HEADERS),
        413,
        "payload_too_large",
    )
    assert catalog.calls == []


async def test_import_accepts_bodies_above_the_default_limit(
    client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    row = "DEMO-{i},demo-{i},mevalar,Demo,Demo," + "d" * 400 + ",,kg,1000,,,true,0,\r\n"
    raw = (",".join(COLUMNS) + "\r\n" + "".join(row.format(i=i) for i in range(400))).encode()
    assert 64 * 1024 < len(raw) < 1024 * 1024
    response = await client.post(f"{CSV}/import", content=raw, headers=CSV_HEADERS)
    assert response.status_code == 200, response.text
    name, args, kwargs = catalog.last()
    assert name == "import_csv"
    assert args[0].total_rows == 400
    assert kwargs["dry_run"] is False


async def test_import_result(client: httpx.AsyncClient, catalog: RecordingRepository) -> None:
    catalog.results["import_csv"] = _outcome(
        applied=False,
        dry_run=True,
        creates=0,
        errors=(CsvRowError(2, "price_uzs", "invalid_money", "Whole UZS"),),
        errors_truncated=True,
    )
    response = await client.post(
        f"{CSV}/import", params={"dry_run": "true"}, content=b"x", headers=CSV_HEADERS
    )
    # The body is parsed first: a single "x" header is refused before the repository.
    error_of(response, 422, "csv_invalid_header")
    raw = (",".join(COLUMNS) + "\r\n").encode()
    response = await client.post(
        f"{CSV}/import", params={"dry_run": "true"}, content=raw, headers=CSV_HEADERS
    )
    assert response.status_code == 200
    assert response.json() == {
        "dry_run": True,
        "applied": False,
        "total_rows": 1,
        "creates": 0,
        "updates": 0,
        "unchanged": 0,
        "errors": [
            {"row": 2, "column": "price_uzs", "code": "invalid_money", "message": "Whole UZS"}
        ],
        "errors_truncated": True,
    }
    assert catalog.last()[2]["dry_run"] is True


async def test_import_rate_limit_is_10_per_minute(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    del app.dependency_overrides[admin_csv.ADMIN_CSV_IMPORT_LIMIT]  # the real in-memory limiter
    raw = (",".join(COLUMNS) + "\r\n").encode()
    for _ in range(10):
        response = await client.post(f"{CSV}/import", content=raw, headers=CSV_HEADERS)
        assert response.status_code == 200
    error_of(
        await client.post(f"{CSV}/import", content=raw, headers=CSV_HEADERS), 429, "rate_limited"
    )


async def test_export_rate_limit_is_20_per_minute(
    app: FastAPI, client: httpx.AsyncClient, catalog: RecordingRepository
) -> None:
    del app.dependency_overrides[admin_csv.ADMIN_CSV_EXPORT_LIMIT]
    for _ in range(20):
        assert (await client.get(f"{CSV}/export")).status_code == 200
    error_of(await client.get(f"{CSV}/export"), 429, "rate_limited")


async def test_openapi_documents_the_admin_catalog(client: httpx.AsyncClient) -> None:
    document = (await client.get("/api/v1/openapi.json")).json()
    paths = document["paths"]
    assert "text/csv" in paths[f"{CSV}/import"]["post"]["requestBody"]["content"]
    assert "text/csv" in paths[f"{CSV}/export"]["get"]["responses"]["200"]["content"]
    for path in (
        CATEGORIES,
        f"{CATEGORIES}/{{category_id}}",
        PRODUCTS,
        f"{PRODUCTS}/{{product_id}}",
    ):
        assert path in paths
    schemas = document["components"]["schemas"]
    for name in ("AdminProduct", "AdminProductPage", "AdminCategoryList", "CsvImportResult"):
        assert name in schemas
