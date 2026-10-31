"""Admin delivery zone/slot routes and the dashboard against fake repositories (no database).

Covers who may call what (admin only for zones and slots, operator and admin for the dashboard,
Login Widget sessions only, 401 without a session), CSRF on writes, the per-route rate limits,
request validation (nothing reaches the repository) and how repository refusals map to errors.
The session and CSRF wiring is also checked end to end with a real (in-memory) session.
"""

import dataclasses
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api import admin_deps, auth_deps
from app.api.routes import admin_dashboard as dashboard_routes
from app.api.routes import admin_delivery as delivery_routes
from app.audit import AuditActor
from app.core.errors import ApiError
from app.models.enums import UserRole
from app.repositories.admin_delivery import (
    AdminDeliveryError,
    AdminSlotRecord,
    AdminZoneRecord,
    CapacityBelowReservedError,
    DistrictTakenError,
    InvalidValueError,
    SlotExistsError,
    SlotInUseError,
    SlotListRecord,
    SlotNotFoundError,
    ZoneInUseError,
    ZoneNotFoundError,
    ZoneSlugTakenError,
)
from app.repositories.dashboard import DashboardRecord
from app.repositories.users import UserRecord
from tests.auth_helpers import TRUSTED_ORIGIN, build_app, cookie_header, http_client, login
from tests.catalog_factories import make_user
from tests.conftest import FakeClock, FakeUserRepository

ZONES = "/api/v1/admin/delivery/zones"
SLOTS = "/api/v1/admin/delivery/slots"
DASHBOARD = "/api/v1/admin/dashboard"
ZONE_ID = uuid.uuid4()
SLOT_ID = uuid.uuid4()
STAMP = datetime(2026, 10, 31, 7, 0, tzinfo=UTC)

ZONE = AdminZoneRecord(
    id=ZONE_ID,
    slug="demo-zone",
    name_uz="Demo zona",
    name_ru="Демо зона",
    delivery_fee_uzs=15_000,
    free_delivery_threshold_uzs=None,
    min_order_uzs=50_000,
    opens_at=time(9, 0),
    closes_at=time(21, 0),
    sort_order=0,
    is_active=True,
    districts=frozenset({"olmazor", "chilonzor"}),
    created_at=STAMP,
    updated_at=STAMP,
)
SLOT = AdminSlotRecord(
    id=SLOT_ID,
    zone_id=ZONE_ID,
    slot_date=date(2026, 11, 2),
    starts_at=time(10, 0),
    ends_at=time(13, 0),
    capacity=5,
    reserved_count=2,
    cutoff_at=datetime(2026, 11, 2, 3, 0, tzinfo=UTC),
    is_active=True,
    created_at=STAMP,
    updated_at=STAMP,
)


def zone_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "slug": "demo-zone",
        "name_uz": "Demo zona",
        "name_ru": "Демо зона",
        "delivery_fee_uzs": 15_000,
        "opens_at": "09:00",
        "closes_at": "21:00",
        "districts": ["chilonzor"],
    }
    body.update(overrides)
    return body


def slot_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "zone_id": str(ZONE_ID),
        "slot_date": "2026-11-02",
        "starts_at": "10:00",
        "ends_at": "13:00",
        "capacity": 5,
        "cutoff_at": "2026-11-02T08:00:00+05:00",
    }
    body.update(overrides)
    return body


class FakeDeliveryRepository:
    def __init__(self) -> None:
        self.error: AdminDeliveryError | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _record(self, name: str, **arguments: Any) -> None:
        self.calls.append((name, arguments))
        if self.error is not None:
            raise self.error

    async def list_zones(self) -> list[AdminZoneRecord]:
        self._record("list_zones")
        return [ZONE]

    async def create_zone(
        self, values: Any, districts: frozenset[str], *, actor: AuditActor
    ) -> AdminZoneRecord:
        self._record("create_zone", values=dict(values), districts=districts, actor=actor)
        return ZONE

    async def update_zone(
        self, zone_id: uuid.UUID, changes: Any, *, actor: AuditActor
    ) -> AdminZoneRecord:
        self._record("update_zone", zone_id=zone_id, changes=dict(changes), actor=actor)
        return ZONE

    async def delete_zone(self, zone_id: uuid.UUID, *, actor: AuditActor) -> None:
        self._record("delete_zone", zone_id=zone_id, actor=actor)

    async def list_slots(
        self, *, zone_id: uuid.UUID | None, date_from: date | None, date_to: date | None
    ) -> SlotListRecord:
        self._record("list_slots", zone_id=zone_id, date_from=date_from, date_to=date_to)
        return SlotListRecord(items=(SLOT,), truncated=False)

    async def create_slot(self, values: Any, *, actor: AuditActor) -> AdminSlotRecord:
        self._record("create_slot", values=dict(values), actor=actor)
        return SLOT

    async def update_slot(
        self, slot_id: uuid.UUID, changes: Any, *, actor: AuditActor
    ) -> AdminSlotRecord:
        self._record("update_slot", slot_id=slot_id, changes=dict(changes), actor=actor)
        return SLOT

    async def delete_slot(self, slot_id: uuid.UUID, *, actor: AuditActor) -> None:
        self._record("delete_slot", slot_id=slot_id, actor=actor)


class FakeDashboardRepository:
    def __init__(self) -> None:
        self.calls: list[datetime] = []

    async def summary(self, now: datetime) -> DashboardRecord:
        self.calls.append(now)
        return DashboardRecord(
            day=date(2026, 11, 1),
            orders_today=4,
            new_orders=2,
            gmv_today_uzs=200_001,
            average_order_value_uzs=66_667,
            cancelled_today=1,
        )


async def _allow() -> None:
    return None


def _raiser(error: ApiError) -> Callable[[], Any]:
    async def dependency() -> None:
        raise error

    return dependency


LIMITS = (admin_deps.ADMIN_IP_LIMIT, admin_deps.ADMIN_READ_LIMIT, admin_deps.ADMIN_WRITE_LIMIT)


@pytest.fixture
def repository(app: FastAPI) -> FakeDeliveryRepository:
    fake = FakeDeliveryRepository()
    app.dependency_overrides[delivery_routes.get_admin_delivery_repository] = lambda: fake
    app.dependency_overrides[auth_deps.require_csrf] = _allow
    app.dependency_overrides[admin_deps.require_back_office_session] = _allow
    for limit in LIMITS:
        app.dependency_overrides[limit] = _allow
    as_role(app, UserRole.ADMIN)
    return fake


@pytest.fixture
def board(app: FastAPI) -> FakeDashboardRepository:
    fake = FakeDashboardRepository()
    app.dependency_overrides[dashboard_routes.get_dashboard_repository] = lambda: fake
    return fake


def as_role(app: FastAPI, role: UserRole) -> UserRecord:
    user = make_user(role=role)
    app.dependency_overrides[auth_deps.get_current_user] = lambda: user
    return user


Request = Callable[[], Awaitable[httpx.Response]]


def requests(client: httpx.AsyncClient) -> list[Request]:
    """Every zone/slot route, with valid bodies."""
    return [
        lambda: client.get(ZONES),
        lambda: client.post(ZONES, json=zone_body()),
        lambda: client.patch(f"{ZONES}/{ZONE_ID}", json={"name_uz": "Demo"}),
        lambda: client.delete(f"{ZONES}/{ZONE_ID}"),
        lambda: client.get(SLOTS),
        lambda: client.post(SLOTS, json=slot_body()),
        lambda: client.patch(f"{SLOTS}/{SLOT_ID}", json={"capacity": 6}),
        lambda: client.delete(f"{SLOTS}/{SLOT_ID}"),
    ]


def error_of(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- roles ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("role", [UserRole.OPERATOR, UserRole.CUSTOMER])
async def test_only_admins_manage_zones_and_slots(
    app: FastAPI,
    client: httpx.AsyncClient,
    repository: FakeDeliveryRepository,
    board: FakeDashboardRepository,
    role: UserRole,
) -> None:
    as_role(app, role)
    unknown = uuid.uuid4()
    extra: list[Request] = [
        lambda: client.patch(f"{ZONES}/{unknown}", json={"name_uz": "Demo"}),
        lambda: client.delete(f"{SLOTS}/{unknown}"),
    ]
    for request in [*requests(client), *extra]:
        response = await request()
        assert response.json() == {"error": {"code": "forbidden", "message": "Admin role required"}}
        assert response.status_code == 403
        assert response.headers["cache-control"] == "no-store"
    assert repository.calls == []
    dashboard = await client.get(DASHBOARD)
    if role is UserRole.OPERATOR:
        assert dashboard.status_code == 200
    else:
        error_of(dashboard, 403, "forbidden")


async def test_admins_reach_every_route(
    app: FastAPI, client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    admin = as_role(app, UserRole.ADMIN)
    statuses = [(await request()).status_code for request in requests(client)]
    assert statuses == [200, 201, 200, 204, 200, 201, 200, 204]
    actor = AuditActor(user_id=admin.id, role=UserRole.ADMIN)
    assert [name for name, _ in repository.calls] == [
        "list_zones",
        "create_zone",
        "update_zone",
        "delete_zone",
        "list_slots",
        "create_slot",
        "update_slot",
        "delete_slot",
    ]
    assert all(call.get("actor", actor) == actor for _, call in repository.calls)


async def test_anonymous_requests_are_401(
    app: FastAPI, client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    app.dependency_overrides[auth_deps.get_current_user] = _raiser(
        ApiError(401, "session_required", "Sign-in required")
    )
    dashboard_request: Request = lambda: client.get(DASHBOARD)  # noqa: E731
    for request in [*requests(client), dashboard_request]:
        error_of(await request(), 401, "session_required")
    assert repository.calls == []


async def test_writes_require_csrf(
    app: FastAPI, client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    app.dependency_overrides[auth_deps.require_csrf] = _raiser(
        ApiError(403, "csrf_failed", "CSRF validation failed")
    )
    for index, request in enumerate(requests(client)):
        response = await request()
        if index in {0, 4}:  # the two lists
            assert response.status_code == 200
        else:
            error_of(response, 403, "csrf_failed")
    assert [name for name, _ in repository.calls] == ["list_zones", "list_slots"]


async def test_each_route_uses_the_admin_limits(
    app: FastAPI, client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    limited = ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "7"})
    reads = {0, 4}
    for limit in (admin_deps.ADMIN_READ_LIMIT, admin_deps.ADMIN_WRITE_LIMIT):
        app.dependency_overrides[limit] = _raiser(limited)
        for index, request in enumerate(requests(client)):
            response = await request()
            uses_it = (index in reads) == (limit is admin_deps.ADMIN_READ_LIMIT)
            assert (response.status_code == 429) == uses_it, (index, response.text)
        app.dependency_overrides[limit] = _allow
    app.dependency_overrides[admin_deps.ADMIN_IP_LIMIT] = _raiser(limited)
    for request in requests(client):
        error_of(await request(), 429, "rate_limited")


# --- real session and CSRF ------------------------------------------------------------------------


async def test_real_session_wiring(clock: FakeClock) -> None:
    users = FakeUserRepository()
    app = build_app(clock, users)
    fake = FakeDeliveryRepository()
    board = FakeDashboardRepository()
    app.dependency_overrides[delivery_routes.get_admin_delivery_repository] = lambda: fake
    app.dependency_overrides[dashboard_routes.get_dashboard_repository] = lambda: board
    async with http_client(app) as client:
        for path in (ZONES, SLOTS, DASHBOARD):
            error_of(await client.get(path), 401, "session_required")

        # A Mini App (initData) session is a storefront session, even for an admin.
        signed_in = await login(client, clock)
        mini_app = cookie_header(signed_in.token)
        mini_csrf = {**mini_app, "Origin": TRUSTED_ORIGIN, "X-CSRF-Token": signed_in.csrf_token}
        [record] = users.users.values()
        users.users[record.telegram_user_id] = dataclasses.replace(record, role=UserRole.ADMIN)
        for path in (ZONES, SLOTS, DASHBOARD):
            error_of(await client.get(path, headers=mini_app), 403, "forbidden")
        error_of(await client.post(ZONES, json=zone_body(), headers=mini_csrf), 403, "forbidden")
        assert fake.calls == []
        assert board.calls == []

        # The same admin through the Login Widget (the admin app's sign-in).
        widget = await app.state.session_manager.create(
            user_id=record.id,
            telegram_user_id=record.telegram_user_id,
            auth_method="telegram_login_widget",
        )
        session = cookie_header(widget.token)
        csrf = {**session, "Origin": TRUSTED_ORIGIN, "X-CSRF-Token": widget.data.csrf_token}
        assert (await client.get(ZONES, headers=session)).status_code == 200
        assert (await client.get(DASHBOARD, headers=session)).status_code == 200
        for headers in (session, {**session, "X-CSRF-Token": "wrong"}):
            error_of(
                await client.post(ZONES, json=zone_body(), headers=headers), 403, "csrf_failed"
            )
            error_of(await client.delete(f"{SLOTS}/{SLOT_ID}", headers=headers), 403, "csrf_failed")
        assert (await client.post(ZONES, json=zone_body(), headers=csrf)).status_code == 201

        # Demoted to operator: zones are refused at once, the dashboard stays.
        users.users[record.telegram_user_id] = dataclasses.replace(record, role=UserRole.OPERATOR)
        error_of(await client.get(ZONES, headers=session), 403, "forbidden")
        assert (await client.get(DASHBOARD, headers=session)).status_code == 200
        assert [name for name, _ in fake.calls] == ["list_zones", "create_zone"]


# --- validation -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        zone_body(opens_at="21:00", closes_at="09:00"),
        zone_body(opens_at="9:00"),
        zone_body(opens_at="09:00:00"),
        zone_body(districts=[]),
        zone_body(districts=["chilonzor", "chilonzor"]),
        zone_body(districts=["toshkent"]),
        zone_body(slug="Demo_Zone"),
        zone_body(slug="x" * 65),
        zone_body(name_ru="Demo\tzona"),
        zone_body(delivery_fee_uzs=10**12 + 1),
        zone_body(free_delivery_threshold_uzs=-5),
        zone_body(sort_order=100_001),
        zone_body(is_active="maybe"),
        zone_body(id=str(uuid.uuid4())),
        {key: value for key, value in zone_body().items() if key != "districts"},
    ],
)
async def test_zone_create_validation(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository, body: dict[str, Any]
) -> None:
    error_of(await client.post(ZONES, json=body), 422, "validation_error")
    assert repository.calls == []


@pytest.mark.parametrize(
    "body",
    [
        slot_body(cutoff_at="2026-11-02T10:00:01+05:00"),
        slot_body(cutoff_at="2026-11-02T05:00:01Z"),
        slot_body(cutoff_at="2026-11-02T08:00:00"),
        slot_body(starts_at="13:00"),
        slot_body(ends_at="25:00"),
        slot_body(capacity=-1),
        slot_body(capacity=10_001),
        slot_body(slot_date="02.11.2026"),
        slot_body(zone_id="zone"),
        slot_body(reserved_count=1),
    ],
)
async def test_slot_create_validation(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository, body: dict[str, Any]
) -> None:
    error_of(await client.post(SLOTS, json=body), 422, "validation_error")
    assert repository.calls == []


async def test_the_cutoff_may_equal_the_start(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    response = await client.post(SLOTS, json=slot_body(cutoff_at="2026-11-02T05:00:00Z"))
    assert response.status_code == 201, response.text
    [(_, call)] = repository.calls
    assert call["values"]["starts_at"] == time(10, 0)
    assert call["values"]["cutoff_at"] == datetime(2026, 11, 2, 5, 0, tzinfo=UTC)


async def test_patch_passes_only_the_fields_sent(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    await client.patch(
        f"{ZONES}/{ZONE_ID}",
        json={"free_delivery_threshold_uzs": None, "districts": ["sergeli", "olmazor"]},
    )
    await client.patch(f"{SLOTS}/{SLOT_ID}", json={"is_active": False, "starts_at": "11:30"})
    [(_, zone_call), (_, slot_call)] = repository.calls
    assert zone_call["changes"] == {
        "districts": frozenset({"sergeli", "olmazor"}),
        "free_delivery_threshold_uzs": None,
    }
    assert slot_call["changes"] == {"is_active": False, "starts_at": time(11, 30)}


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (f"{ZONES}/{ZONE_ID}", {"slug": None}),
        (f"{ZONES}/{ZONE_ID}", {"delivery_fee_uzs": None}),
        (f"{ZONES}/{ZONE_ID}", {"districts": None}),
        (f"{ZONES}/{ZONE_ID}", {"districts": []}),
        (f"{ZONES}/{ZONE_ID}", {"closes_at": "late"}),
        (f"{ZONES}/{ZONE_ID}", {"unknown": 1}),
        (f"{ZONES}/not-a-uuid", {"name_uz": "Demo"}),
        (f"{SLOTS}/{SLOT_ID}", {"capacity": None}),
        (f"{SLOTS}/{SLOT_ID}", {"cutoff_at": "2026-11-02T08:00:00"}),
        (f"{SLOTS}/{SLOT_ID}", {"zone_id": str(ZONE_ID)}),
        (f"{SLOTS}/{SLOT_ID}", {"reserved_count": 0}),
    ],
)
async def test_patch_validation(
    client: httpx.AsyncClient,
    repository: FakeDeliveryRepository,
    path: str,
    body: dict[str, Any],
) -> None:
    error_of(await client.patch(path, json=body), 422, "validation_error")
    assert repository.calls == []


async def test_slot_list_filters(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    response = await client.get(
        SLOTS, params={"zone_id": str(ZONE_ID), "date_from": "2026-11-01", "date_to": "2026-11-07"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is False
    assert body["items"][0] == {
        "id": str(SLOT_ID),
        "zone_id": str(ZONE_ID),
        "slot_date": "2026-11-02",
        "starts_at": "10:00",
        "ends_at": "13:00",
        "capacity": 5,
        "reserved_count": 2,
        "remaining": 3,
        "cutoff_at": "2026-11-02T03:00:00Z",
        "is_active": True,
        "created_at": "2026-10-31T07:00:00Z",
        "updated_at": "2026-10-31T07:00:00Z",
    }
    assert repository.calls == [
        (
            "list_slots",
            {"zone_id": ZONE_ID, "date_from": date(2026, 11, 1), "date_to": date(2026, 11, 7)},
        )
    ]
    error_of(
        await client.get(SLOTS, params={"date_from": "2026-11-07", "date_to": "2026-11-01"}),
        422,
        "validation_error",
    )
    assert len(repository.calls) == 1


async def test_zone_response_shape(
    client: httpx.AsyncClient, repository: FakeDeliveryRepository
) -> None:
    [zone] = (await client.get(ZONES)).json()["items"]
    assert zone["districts"] == [
        {"code": "chilonzor", "name_uz": "Chilonzor", "name_ru": "Чиланзарский"},
        {"code": "olmazor", "name_uz": "Olmazor", "name_ru": "Алмазарский"},
    ]
    assert (zone["opens_at"], zone["closes_at"]) == ("09:00", "21:00")
    assert zone["free_delivery_threshold_uzs"] is None


# --- refusals -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "status", "expected"),
    [
        (DistrictTakenError("chilonzor"), 409, {"code": "district_taken", "district": "chilonzor"}),
        (ZoneNotFoundError(), 404, {"code": "zone_not_found"}),
        (SlotNotFoundError(), 404, {"code": "slot_not_found"}),
        (ZoneSlugTakenError(), 409, {"code": "slug_taken"}),
        (ZoneInUseError(), 409, {"code": "zone_in_use"}),
        (SlotExistsError(), 409, {"code": "slot_exists"}),
        (SlotInUseError(), 409, {"code": "slot_in_use"}),
        (CapacityBelowReservedError(3), 409, {"code": "capacity_below_reserved"}),
        (
            InvalidValueError("cutoff_at", "cutoff_at must not be after the slot starts"),
            422,
            {
                "code": "validation_error",
                "details": [
                    {
                        "loc": ["body", "cutoff_at"],
                        "msg": "cutoff_at must not be after the slot starts",
                    }
                ],
            },
        ),
    ],
)
async def test_refusals_map_to_errors(
    client: httpx.AsyncClient,
    repository: FakeDeliveryRepository,
    error: AdminDeliveryError,
    status: int,
    expected: dict[str, Any],
) -> None:
    repository.error = error
    for request in requests(client)[1:4] + requests(client)[5:]:  # every write
        response = await request()
        assert response.status_code == status
        assert response.headers["cache-control"] == "no-store"
        body = response.json()["error"]
        assert {key: value for key, value in body.items() if key != "message"} == expected
        assert body["message"]


# --- dashboard ------------------------------------------------------------------------------------


async def test_dashboard_uses_the_app_clock(
    app: FastAPI,
    client: httpx.AsyncClient,
    repository: FakeDeliveryRepository,
    board: FakeDashboardRepository,
    clock: FakeClock,
) -> None:
    as_role(app, UserRole.OPERATOR)
    response = await client.get(DASHBOARD)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "date": "2026-11-01",
        "timezone": "Asia/Tashkent",
        "orders_today": 4,
        "new_orders": 2,
        "gmv_today_uzs": 200_001,
        "average_order_value_uzs": 66_667,
        "cancelled_today": 1,
    }
    assert board.calls == [datetime.fromtimestamp(clock.now, tz=UTC)]
    app.dependency_overrides[admin_deps.ADMIN_READ_LIMIT] = _raiser(
        ApiError(429, "rate_limited", "Too many requests", headers={"Retry-After": "1"})
    )
    error_of(await client.get(DASHBOARD), 429, "rate_limited")
    assert len(board.calls) == 1


async def test_openapi_documents_the_admin_routes(client: httpx.AsyncClient) -> None:
    spec = (await client.get("/api/v1/openapi.json")).json()
    paths = spec["paths"]
    assert set(paths[ZONES]) == {"get", "post"}
    assert set(paths[f"{ZONES}/{{zone_id}}"]) == {"patch", "delete"}
    assert set(paths[SLOTS]) == {"get", "post"}
    assert set(paths[f"{SLOTS}/{{slot_id}}"]) == {"patch", "delete"}
    assert "get" in paths[DASHBOARD]
    assert {"409", "422"} <= set(paths[ZONES]["post"]["responses"])
    error_codes = spec["components"]["schemas"]["ApiErrorBody"]["properties"]["code"]["enum"]
    assert {"slot_required", "slot_unavailable", "slot_full", "district_taken"} <= set(error_codes)
    assert "district" in spec["components"]["schemas"]["ApiErrorBody"]["properties"]
    quote = spec["components"]["schemas"]["CheckoutQuote"]["properties"]
    assert {"slot_required", "delivery_slots"} <= set(quote)
