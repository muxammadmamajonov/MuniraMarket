"""Admin user-management and audit-log routes against recording fakes (no database)."""

import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api import admin_deps, auth_deps
from app.api.routes import admin_audit, admin_users
from app.core.errors import ApiError
from app.models.enums import UserRole
from app.repositories.admin_users import (
    ActorNotAdminError,
    AdminUserError,
    AdminUserPageRecord,
    CannotBlockSelfError,
    LastAdminError,
    UserNotFoundError,
)
from app.repositories.audit import AuditEntryRecord, AuditFilter, AuditPageRecord
from app.schemas.admin_users import AdminUser
from tests.admin_factories import (
    ADMIN_LIMITS,
    AUDIT_ROUTES,
    CREATED_AT,
    USER_ROUTES,
    RecordingRepository,
    Route,
    error_of,
    make_admin_user_record,
)
from tests.catalog_factories import make_user

USERS = "/api/v1/admin/users"
AUDIT = "/api/v1/admin/audit"
USER_ID = uuid.uuid4()
ROUTES = (*USER_ROUTES, *AUDIT_ROUTES)


async def _allow() -> None:
    return None


def _raiser(error: ApiError) -> Any:
    async def dependency() -> None:
        raise error

    return dependency


def as_role(app: FastAPI, role: UserRole) -> Any:
    user = make_user(role=role)
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    return user


@pytest.fixture
def repos(app: FastAPI) -> tuple[RecordingRepository, RecordingRepository]:
    users = RecordingRepository(
        list_users=AdminUserPageRecord(items=(make_admin_user_record(),), total=1),
        update_user=make_admin_user_record(id=USER_ID, role=UserRole.OPERATOR),
    )
    audit = RecordingRepository(
        list_entries=AuditPageRecord(
            items=(
                AuditEntryRecord(
                    id=uuid.uuid4(),
                    created_at=CREATED_AT,
                    actor_user_id=uuid.uuid4(),
                    actor_role=UserRole.ADMIN,
                    action="product.update",
                    entity_type="product",
                    entity_id=str(uuid.uuid4()),
                    details={"changes": {"price_uzs": {"from": 1, "to": 2}}},
                ),
            ),
            total=101,
        )
    )
    app.dependency_overrides[admin_users.get_admin_user_repository] = lambda: users
    app.dependency_overrides[admin_audit.get_audit_repository] = lambda: audit
    app.dependency_overrides[auth_deps.require_csrf] = _allow
    app.dependency_overrides[admin_deps.require_back_office_session] = _allow
    for limit in ADMIN_LIMITS:
        app.dependency_overrides[limit] = _allow
    as_role(app, UserRole.ADMIN)
    return users, audit


# --- access control ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES, ids=str)
@pytest.mark.parametrize("role", [UserRole.OPERATOR, UserRole.CUSTOMER])
async def test_only_admins(
    app: FastAPI,
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    route: Route,
    role: UserRole,
) -> None:
    as_role(app, role)
    response = await route.send(client)
    assert response.json() == {"error": {"code": "forbidden", "message": "Admin role required"}}
    assert response.status_code == 403
    assert all(repo.calls == [] for repo in repos)


@pytest.mark.parametrize("route", ROUTES, ids=str)
async def test_anonymous_is_401(
    app: FastAPI,
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    route: Route,
) -> None:
    app.dependency_overrides[auth_deps.get_current_user] = _raiser(
        ApiError(401, "session_required", "Sign-in required")
    )
    error_of(await route.send(client), 401, "session_required")


@pytest.mark.parametrize("route", ROUTES, ids=str)
async def test_mini_app_sessions_are_refused(
    app: FastAPI,
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    route: Route,
) -> None:
    app.dependency_overrides[admin_deps.require_back_office_session] = _raiser(
        admin_deps.staff_required()
    )
    error_of(await route.send(client), 403, "forbidden")
    assert all(repo.calls == [] for repo in repos)


async def test_user_writes_require_csrf(
    app: FastAPI, client: httpx.AsyncClient, repos: tuple[RecordingRepository, RecordingRepository]
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF validation failed")
    )
    error_of(await client.patch(f"{USERS}/{USER_ID}", json={"role": "admin"}), 403, "csrf_failed")
    assert (await client.get(USERS)).status_code == 200
    assert (await client.get(AUDIT)).status_code == 200
    assert [name for name, *_ in repos[0].calls] == ["list_users"]


# --- users ------------------------------------------------------------------------------------


async def test_list_users(
    client: httpx.AsyncClient, repos: tuple[RecordingRepository, RecordingRepository]
) -> None:
    users, _ = repos
    response = await client.get(
        USERS, params={"q": " Demo ", "role": "operator", "blocked": "false", "page_size": 100}
    )
    assert response.status_code == 200
    [item] = response.json()["items"]
    assert "phone" not in item
    assert users.last()[2] == {
        "query": "Demo",
        "role": UserRole.OPERATOR,
        "blocked": False,
        "page": 1,
        "page_size": 100,
    }


def test_admin_user_schema_has_no_phone() -> None:
    assert not any("phone" in name for name in AdminUser.model_fields)


@pytest.mark.parametrize(
    "params", [{"page_size": 101}, {"role": "root"}, {"blocked": "maybe"}, {"q": "x" * 101}]
)
async def test_list_users_bounds(
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    params: dict[str, Any],
) -> None:
    error_of(await client.get(USERS, params=params), 422, "validation_error")


async def test_update_user(
    app: FastAPI, client: httpx.AsyncClient, repos: tuple[RecordingRepository, RecordingRepository]
) -> None:
    users, _ = repos
    admin = as_role(app, UserRole.ADMIN)
    response = await client.patch(f"{USERS}/{USER_ID}", json={"role": "operator"})
    assert response.status_code == 200
    assert response.json()["role"] == "operator"
    name, args, kwargs = users.last()
    assert (name, args) == ("update_user", (USER_ID,))
    assert kwargs["role"] is UserRole.OPERATOR
    assert kwargs["is_blocked"] is None
    assert kwargs["actor"].user_id == admin.id
    await client.patch(f"{USERS}/{USER_ID}", json={"is_blocked": True})
    assert users.last()[2]["is_blocked"] is True
    assert users.last()[2]["role"] is None


@pytest.mark.parametrize(
    "body",
    [{}, {"role": None}, {"is_blocked": None}, {"role": "root"}, {"phone": "+998"}],
)
async def test_update_user_validation(
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    body: dict[str, Any],
) -> None:
    error_of(await client.patch(f"{USERS}/{USER_ID}", json=body), 422, "validation_error")
    assert repos[0].calls == []


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (UserNotFoundError(), 404, "user_not_found"),
        (LastAdminError(), 409, "last_admin"),
        (CannotBlockSelfError(), 409, "cannot_block_self"),
        (ActorNotAdminError(), 403, "forbidden"),
    ],
)
async def test_update_user_errors(
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    error: AdminUserError,
    status: int,
    code: str,
) -> None:
    repos[0].error = error
    error_of(await client.patch(f"{USERS}/{USER_ID}", json={"is_blocked": True}), status, code)


# --- audit ------------------------------------------------------------------------------------


async def test_list_audit(
    client: httpx.AsyncClient, repos: tuple[RecordingRepository, RecordingRepository]
) -> None:
    _, audit = repos
    actor = uuid.uuid4()
    response = await client.get(
        AUDIT,
        params={
            "entity_type": "product",
            "entity_id": "abc",
            "action": "product.update",
            "actor_user_id": str(actor),
            "page": 2,
            "page_size": 50,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["total_pages"]) == (101, 3)
    [entry] = body["items"]
    assert set(entry) == {
        "id",
        "created_at",
        "actor_user_id",
        "actor_role",
        "action",
        "entity_type",
        "entity_id",
        "details",
    }
    assert entry["details"] == {"changes": {"price_uzs": {"from": 1, "to": 2}}}
    _, args, kwargs = audit.last()
    assert args == (
        AuditFilter(
            entity_type="product", entity_id="abc", action="product.update", actor_user_id=actor
        ),
    )
    assert kwargs == {"page": 2, "page_size": 50}


@pytest.mark.parametrize(
    "params",
    [
        {"entity_type": "Product"},
        {"entity_type": "x" * 33},
        {"action": "drop table"},
        {"action": "product"},
        {"entity_id": "x" * 65},
        {"actor_user_id": "nope"},
        {"page_size": 101},
    ],
)
async def test_audit_filter_validation(
    client: httpx.AsyncClient,
    repos: tuple[RecordingRepository, RecordingRepository],
    params: dict[str, Any],
) -> None:
    error_of(await client.get(AUDIT, params=params), 422, "validation_error")
    assert repos[1].calls == []
