"""Helpers for the admin catalog / CSV / users / audit tests (not collected by pytest)."""

import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import admin_deps
from app.api.deps import get_session
from app.api.routes import admin_csv
from app.core.clock import Clock, system_clock
from app.main import create_app
from app.models.audit import AuditLog
from app.models.enums import Unit, UserRole
from app.repositories.admin_catalog import AdminCategoryRecord, AdminProductRecord
from app.repositories.admin_users import AdminUserRecord
from app.repositories.users import UserRecord
from app.security.service_auth import InMemoryNonceStore
from tests.conftest import make_settings
from tests.db_data import SessionFactory, build_app

TRUSTED_ORIGIN = "https://admin.example"
SECURE_COOKIE = "__Host-mm_session"
CREATED_AT = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)

CSV_LIMITS = (admin_csv.ADMIN_CSV_IMPORT_LIMIT, admin_csv.ADMIN_CSV_EXPORT_LIMIT)
ADMIN_LIMITS = (
    admin_deps.ADMIN_IP_LIMIT,
    admin_deps.ADMIN_READ_LIMIT,
    admin_deps.ADMIN_WRITE_LIMIT,
    *CSV_LIMITS,
)

CSV_HEADERS = {"Content-Type": "text/csv; charset=utf-8"}


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    json: dict[str, Any] | None = None
    content: bytes | None = None
    headers: dict[str, str] | None = None

    @property
    def is_write(self) -> bool:
        return self.method not in ("GET", "HEAD")

    def send(self, client: httpx.AsyncClient, headers: dict[str, str] | None = None) -> Any:
        return client.request(
            self.method,
            self.path,
            json=self.json,
            content=self.content,
            headers={**(self.headers or {}), **(headers or {})},
        )

    def __str__(self) -> str:
        return f"{self.method} {self.path}"


# Unknown ids on purpose: a wrong role must get 403 without learning whether they exist.
_ID = uuid.uuid4()
CATALOG_ROUTES = (
    Route("GET", "/api/v1/admin/categories"),
    Route("POST", "/api/v1/admin/categories", json={"slug": "x", "name_uz": "x", "name_ru": "x"}),
    Route("PATCH", f"/api/v1/admin/categories/{_ID}", json={"name_uz": "x"}),
    Route("DELETE", f"/api/v1/admin/categories/{_ID}"),
    Route("GET", "/api/v1/admin/products"),
    Route("GET", f"/api/v1/admin/products/{_ID}"),
    Route(
        "POST",
        "/api/v1/admin/products",
        json={
            "sku": "DEMO-1",
            "slug": "demo-1",
            "category_id": str(_ID),
            "name_uz": "x",
            "name_ru": "x",
            "unit": "kg",
            "price_uzs": 1000,
        },
    ),
    Route("PATCH", f"/api/v1/admin/products/{_ID}", json={"price_uzs": 1}),
    Route("DELETE", f"/api/v1/admin/products/{_ID}"),
    Route("POST", f"/api/v1/admin/products/{_ID}/restore"),
)
CSV_ROUTES = (
    Route("GET", "/api/v1/admin/catalog/csv/template"),
    Route("GET", "/api/v1/admin/catalog/csv/export"),
    Route(
        "POST",
        "/api/v1/admin/catalog/csv/import?dry_run=true",
        content=b"sku\r\n",
        headers=CSV_HEADERS,
    ),
)
USER_ROUTES = (
    Route("GET", "/api/v1/admin/users"),
    Route("PATCH", f"/api/v1/admin/users/{_ID}", json={"role": "admin"}),
)
AUDIT_ROUTES = (Route("GET", "/api/v1/admin/audit"),)
ALL_ADMIN_ROUTES = (*CATALOG_ROUTES, *CSV_ROUTES, *USER_ROUTES, *AUDIT_ROUTES)


class RecordingRepository:
    """Stands in for any repository: records calls, returns ``results[name]`` or raises."""

    def __init__(self, **results: Any) -> None:
        self.results = results
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.error: Exception | None = None

    def __getattr__(self, name: str) -> Callable[..., Any]:
        if name.startswith("_"):
            raise AttributeError(name)

        async def method(*args: Any, **kwargs: Any) -> Any:
            self.calls.append((name, args, kwargs))
            if self.error is not None:
                raise self.error
            return self.results.get(name)

        return method

    def last(self) -> tuple[str, tuple[Any, ...], dict[str, Any]]:
        return self.calls[-1]


def make_category_record(**overrides: Any) -> AdminCategoryRecord:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "parent_id": None,
        "slug": "mevalar",
        "name_uz": "Mevalar",
        "name_ru": "Фрукты",
        "image_url": None,
        "sort_order": 0,
        "is_active": True,
        "product_count": 0,
        "child_count": 0,
        "created_at": CREATED_AT,
        "updated_at": CREATED_AT,
    }
    values.update(overrides)
    return AdminCategoryRecord(**values)


def make_product_record(**overrides: Any) -> AdminProductRecord:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "sku": "DEMO-0001",
        "slug": "demo-olma",
        "category_id": uuid.uuid4(),
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "description_uz": None,
        "description_ru": None,
        "unit": Unit.KG,
        "price_uzs": 12_000,
        "old_price_uzs": None,
        "stock_quantity": None,
        "image_url": None,
        "sort_order": 0,
        "is_active": True,
        "archived_at": None,
        "created_at": CREATED_AT,
        "updated_at": CREATED_AT,
    }
    values.update(overrides)
    return AdminProductRecord(**values)


def make_admin_user_record(**overrides: Any) -> AdminUserRecord:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "telegram_user_id": 555_000_222,
        "first_name": "Demo",
        "last_name": None,
        "username": None,
        "language": "uz",
        "role": UserRole.CUSTOMER,
        "is_blocked": False,
        "created_at": CREATED_AT,
    }
    values.update(overrides)
    return AdminUserRecord(**values)


# --- real database -------------------------------------------------------------------------------


def build_admin_app(
    factory: SessionFactory, users: list[UserRecord], *, clock: Clock = system_clock
) -> FastAPI:
    """``tests.db_data.build_app`` (signed-in user from the ``x-test-user`` header, CSRF and
    rate limits off) plus the CSV rate limits switched off."""
    app = build_app(factory, users, clock=clock)

    async def allow() -> None:
        return None

    for limit in CSV_LIMITS:
        app.dependency_overrides[limit] = allow
    return app


def build_session_app(factory: SessionFactory, *, clock: Clock = system_clock) -> FastAPI:
    """The real app with real (in-memory) sessions, CSRF and rate limits on the test schema."""
    app = create_app(
        make_settings(csrf_trusted_origins=TRUSTED_ORIGIN),
        clock=clock,
        nonce_store=InMemoryNonceStore(clock),
    )

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    return app


@dataclass(frozen=True)
class StaffSession:
    cookie: dict[str, str]
    csrf: dict[str, str]


async def widget_session(app: FastAPI, user: UserRecord) -> StaffSession:
    """A Login Widget (back-office) session for ``user``, as the admin app would hold."""
    issued = await app.state.session_manager.create(
        user_id=user.id,
        telegram_user_id=user.telegram_user_id,
        auth_method="telegram_login_widget",
    )
    cookie = {"Cookie": f"{SECURE_COOKIE}={issued.token}"}
    return StaffSession(
        cookie=cookie,
        csrf={**cookie, "Origin": TRUSTED_ORIGIN, "X-CSRF-Token": issued.data.csrf_token},
    )


async def audit_rows(factory: SessionFactory, *where: Any) -> list[AuditLog]:
    async with factory() as session:
        rows = await session.execute(
            select(AuditLog).where(*where).order_by(AuditLog.created_at, AuditLog.id)
        )
        return list(rows.scalars())


def error_of(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code, body
    return body
