"""Admin delivery zones and slots over HTTP against a real PostgreSQL schema (real migrations).

Covers create/list/update/delete with their audit rows (written in the same transaction, only for
real changes), district ownership (``district_taken``), the slot rules (cutoff vs. start in
Asia/Tashkent, capacity vs. booked places, moving or deleting a booked slot) and that operators
are refused before anything is read or written.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, time
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select

from app.audit import AuditActor, AuditEntity
from app.models.audit import AuditLog
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict
from app.models.enums import UserRole
from app.repositories.admin_delivery import (
    SlotInUseError,
    SqlAlchemyAdminDeliveryRepository,
    ZoneInUseError,
)
from app.repositories.users import UserRecord
from tests.conftest import FakeClock
from tests.db_data import (
    TEST_USER_HEADER,
    SessionFactory,
    add_category,
    add_product,
    add_slot,
    add_user,
    add_zone,
    audit_rows,
    build_app,
    slot_state,
)
from tests.db_support import INTEGRATION_MARKS
from tests.order_factories import order_body

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

ZONES = "/api/v1/admin/delivery/zones"
SLOTS = "/api/v1/admin/delivery/slots"
NOW = datetime(2026, 11, 1, 5, 0, tzinfo=UTC)  # 10:00 in Tashkent
DAY = date(2026, 11, 2)


def zone_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "slug": "demo-new",
        "name_uz": "Demo yangi zona",
        "name_ru": "Демо новая зона",
        "delivery_fee_uzs": 20_000,
        "free_delivery_threshold_uzs": 400_000,
        "min_order_uzs": 60_000,
        "opens_at": "08:30",
        "closes_at": "22:00",
        "sort_order": 5,
        "districts": ["sergeli", "bektemir"],
    }
    body.update(overrides)
    return body


def slot_body(zone_id: uuid.UUID, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "zone_id": str(zone_id),
        "slot_date": DAY.isoformat(),
        "starts_at": "10:00",
        "ends_at": "13:00",
        "capacity": 8,
        # Exactly the start (10:00 in Tashkent): the latest allowed cutoff.
        "cutoff_at": "2026-11-02T05:00:00Z",
    }
    body.update(overrides)
    return body


class Admin:
    def __init__(
        self, client: httpx.AsyncClient, factory: SessionFactory, users: list[UserRecord]
    ) -> None:
        self.client = client
        self.factory = factory
        self.admin, self.operator, self.customer = users

    def headers(self, user: UserRecord | None = None) -> dict[str, str]:
        return {TEST_USER_HEADER: str((user or self.admin).id)}

    def get(self, path: str, user: UserRecord | None = None, **params: Any) -> Any:
        return self.client.get(path, params=params, headers=self.headers(user))

    def post(self, path: str, body: dict[str, Any], user: UserRecord | None = None) -> Any:
        return self.client.post(path, json=body, headers=self.headers(user))

    def patch(self, path: str, body: dict[str, Any], user: UserRecord | None = None) -> Any:
        return self.client.patch(path, json=body, headers=self.headers(user))

    def delete(self, path: str, user: UserRecord | None = None) -> Any:
        return self.client.delete(path, headers=self.headers(user))

    async def districts(self, zone_id: str) -> set[str]:
        async with self.factory() as session:
            rows = await session.execute(
                select(DeliveryZoneDistrict.district).where(
                    DeliveryZoneDistrict.zone_id == uuid.UUID(zone_id)
                )
            )
            return set(rows.scalars())


@pytest_asyncio.fixture(loop_scope="module")
async def api(session_factory: SessionFactory) -> AsyncIterator[Admin]:
    users = [
        await add_user(session_factory, role=UserRole.ADMIN),
        await add_user(session_factory, role=UserRole.OPERATOR),
        await add_user(session_factory),
    ]
    app = build_app(session_factory, users, clock=FakeClock(NOW.timestamp()))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Admin(client, session_factory, users)


def error(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()["error"]
    assert body["code"] == code
    return body


# --- zones ----------------------------------------------------------------------------------------


async def test_create_and_list_zones(api: Admin) -> None:
    inactive = await add_zone(api.factory, "demo-old", ["uchtepa"], is_active=False, sort_order=9)
    response = await api.post(ZONES, zone_body())
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    zone = response.json()
    assert zone["slug"] == "demo-new"
    assert (zone["opens_at"], zone["closes_at"]) == ("08:30", "22:00")
    assert zone["is_active"] is True
    # Districts in the documented order, with names.
    assert [district["code"] for district in zone["districts"]] == ["bektemir", "sergeli"]
    assert zone["districts"][0]["name_uz"] == "Bektemir"

    listing = (await api.get(ZONES)).json()["items"]
    assert [item["slug"] for item in listing] == ["demo-new", "demo-old"]  # sort order
    assert listing[1]["id"] == str(inactive.id)
    assert listing[1]["is_active"] is False

    [audit] = await audit_rows(api.factory)
    assert (audit.action, audit.entity_type, audit.entity_id) == (
        "zone.create",
        AuditEntity.ZONE,
        zone["id"],
    )
    assert (audit.actor_user_id, audit.actor_role) == (api.admin.id, UserRole.ADMIN)
    assert audit.details["changes"]["districts"] == {"from": None, "to": "bektemir,sergeli"}
    assert audit.details["changes"]["opens_at"] == {"from": None, "to": "08:30:00"}
    assert audit.details["changes"]["free_delivery_threshold_uzs"]["to"] == 400_000
    assert (audit.details["slug"], audit.details["district_count"]) == ("demo-new", 2)


async def test_zone_validation(api: Admin) -> None:
    bad_bodies = [
        zone_body(opens_at="22:00", closes_at="08:00"),
        zone_body(opens_at="9:00"),
        zone_body(closes_at="24:00"),
        zone_body(districts=[]),
        zone_body(districts=["sergeli", "sergeli"]),
        zone_body(districts=["tashkent"]),
        zone_body(slug="Demo Zone"),
        zone_body(name_uz="Demo\nzona"),
        zone_body(delivery_fee_uzs=-1),
        zone_body(extra=1),
    ]
    for body in bad_bodies:
        error(await api.post(ZONES, body), 422, "validation_error")
    assert await audit_rows(api.factory) == []


async def test_district_and_slug_conflicts(api: Admin) -> None:
    await add_zone(api.factory, "demo-taken", ["chilonzor"])
    body = error(
        await api.post(ZONES, zone_body(districts=["sergeli", "chilonzor"])), 409, "district_taken"
    )
    assert body["district"] == "chilonzor"
    error(
        await api.post(ZONES, zone_body(slug="demo-taken", districts=["sergeli"])),
        409,
        "slug_taken",
    )
    # Nothing of the refused zones was written.
    async with api.factory() as session:
        slugs = set((await session.execute(select(DeliveryZone.slug))).scalars())
    assert slugs == {"demo-taken"}
    assert await audit_rows(api.factory) == []

    created = (await api.post(ZONES, zone_body(districts=["sergeli"]))).json()
    body = error(
        await api.patch(f"{ZONES}/{created['id']}", {"districts": ["chilonzor"]}),
        409,
        "district_taken",
    )
    assert body["district"] == "chilonzor"
    error(await api.patch(f"{ZONES}/{created['id']}", {"slug": "demo-taken"}), 409, "slug_taken")
    assert await api.districts(created["id"]) == {"sergeli"}


async def test_patch_changes_only_the_fields_sent(api: Admin) -> None:
    created = (await api.post(ZONES, zone_body())).json()
    path = f"{ZONES}/{created['id']}"

    response = await api.patch(
        path, {"name_uz": "  Demo nomi  ", "free_delivery_threshold_uzs": None}
    )
    assert response.status_code == 200, response.text
    zone = response.json()
    assert zone["name_uz"] == "Demo nomi"
    assert zone["free_delivery_threshold_uzs"] is None
    unchanged = {"name_ru", "delivery_fee_uzs", "min_order_uzs", "opens_at", "closes_at", "slug"}
    assert {key: zone[key] for key in unchanged} == {key: created[key] for key in unchanged}
    assert zone["districts"] == created["districts"]

    [_, update] = await audit_rows(api.factory)
    assert update.action == "zone.update"
    assert update.details["changes"] == {
        "name_uz": {"from": "Demo yangi zona", "to": "Demo nomi"},
        "free_delivery_threshold_uzs": {"from": 400_000, "to": None},
    }

    # A no-op PATCH (same values, or nothing) writes no audit row.
    assert (await api.patch(path, {"name_uz": "Demo nomi"})).status_code == 200
    assert (await api.patch(path, {})).status_code == 200
    assert len(await audit_rows(api.factory)) == 2

    # null is refused where it means nothing; the merged hours must stay ordered.
    for null_body in (
        {"slug": None},
        {"opens_at": None},
        {"districts": None},
        {"is_active": None},
    ):
        error(await api.patch(path, null_body), 422, "validation_error")
    body = error(await api.patch(path, {"opens_at": "23:00"}), 422, "validation_error")
    assert body["details"] == [
        {"loc": ["body", "closes_at"], "msg": "opens_at must be before closes_at"}
    ]
    after_refusals = await audit_rows(api.factory)
    assert len(after_refusals) == 2

    # Districts are replaced as a set; a freed district can be claimed by another zone.
    response = await api.patch(path, {"districts": ["sergeli", "yangihayot"], "is_active": False})
    assert [d["code"] for d in response.json()["districts"]] == ["sergeli", "yangihayot"]
    assert response.json()["is_active"] is False
    assert await api.districts(created["id"]) == {"sergeli", "yangihayot"}
    other = await api.post(ZONES, zone_body(slug="demo-other", districts=["bektemir"]))
    assert other.status_code == 201, other.text
    last = (await audit_rows(api.factory))[-2]
    assert last.details["changes"]["districts"] == {
        "from": "bektemir,sergeli",
        "to": "sergeli,yangihayot",
    }
    assert last.details["changes"]["is_active"] == {"from": True, "to": False}

    error(await api.patch(f"{ZONES}/{uuid.uuid4()}", {"name_uz": "X"}), 404, "zone_not_found")


async def test_delete_zone(api: Admin) -> None:
    free = (
        await api.post(ZONES, zone_body(slug="demo-free", districts=["sergeli", "bektemir"]))
    ).json()
    response = await api.delete(f"{ZONES}/{free['id']}")
    assert response.status_code == 204
    assert response.content == b""
    assert await api.districts(free["id"]) == set()  # cascaded
    deleted = (await audit_rows(api.factory))[-1]
    # The districts the zone served are recorded, like zone.update does.
    assert (deleted.action, deleted.entity_id, deleted.details) == (
        "zone.delete",
        free["id"],
        {
            "changes": {"districts": {"from": "bektemir,sergeli", "to": None}},
            "slug": "demo-free",
            "district_count": 2,
        },
    )
    error(await api.delete(f"{ZONES}/{free['id']}"), 404, "zone_not_found")

    # A zone with a slot, or one an order points at, stays.
    with_slot = await add_zone(api.factory, "demo-slotted", ["olmazor"])
    await add_slot(api.factory, with_slot, DAY)
    error(await api.delete(f"{ZONES}/{with_slot.id}"), 409, "zone_in_use")

    ordered = await add_zone(api.factory, "demo-ordered", ["chilonzor"])
    category = await add_category(api.factory, "zone-cat")
    product = await add_product(api.factory, category, "zone-apple", price=60_000)
    headers = {TEST_USER_HEADER: str(api.customer.id)}
    await api.client.post(
        "/api/v1/cart/items", json={"product_id": str(product.id), "quantity": 1}, headers=headers
    )
    placed = await api.client.post(
        "/api/v1/orders",
        json=order_body(expected_total_uzs=75_000),
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert placed.status_code == 201, placed.text
    error(await api.delete(f"{ZONES}/{ordered.id}"), 409, "zone_in_use")
    assert [row.action for row in await audit_rows(api.factory)] == ["zone.create", "zone.delete"]


class _CheckedTooEarly(SqlAlchemyAdminDeliveryRepository):
    """Its reference checks ran before a referencing row committed (the race the foreign keys
    still catch): they see nothing."""

    async def _zone_referenced(self, zone_id: uuid.UUID) -> bool:
        return False

    async def _slot_referenced(self, slot_id: uuid.UUID) -> bool:
        return False


async def test_deletes_losing_a_race_to_a_reference_are_409_not_500(api: Admin) -> None:
    actor = AuditActor(user_id=api.admin.id, role=UserRole.ADMIN)
    zone = await add_zone(api.factory, "demo-raced", ["olmazor"])
    await add_slot(api.factory, zone, DAY)
    async with api.factory() as session:
        with pytest.raises(ZoneInUseError):
            await _CheckedTooEarly(session).delete_zone(zone.id, actor=actor)
    assert await api.districts(str(zone.id)) == {"olmazor"}

    # A slot an order points at (the order was cancelled, so no place is reserved any more).
    category = await add_category(api.factory, "race-cat")
    product = await add_product(api.factory, category, "race-apple", price=60_000)
    slot = await add_slot(api.factory, zone, DAY, starts_at=time(15, 0), ends_at=time(16, 0))
    headers = {TEST_USER_HEADER: str(api.customer.id)}
    await api.client.post(
        "/api/v1/cart/items", json={"product_id": str(product.id), "quantity": 1}, headers=headers
    )
    placed = await api.client.post(
        "/api/v1/orders",
        json={
            **order_body(
                expected_total_uzs=75_000,
                address={"district": "olmazor", "street": "Demo ko'cha", "house": "1"},
            ),
            "delivery_slot_id": str(slot.id),
        },
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert placed.status_code == 201, placed.text
    cancelled = await api.client.post(
        f"/api/v1/orders/{placed.json()['id']}/cancel", json={"reason": "Demo"}, headers=headers
    )
    assert cancelled.status_code == 200
    async with api.factory() as session:
        with pytest.raises(SlotInUseError):
            await _CheckedTooEarly(session).delete_slot(slot.id, actor=actor)
        assert await session.get(DeliverySlot, slot.id) is not None
    # Nothing was audited for the refused deletes (only the customer's cancellation).
    assert [row.action for row in await audit_rows(api.factory)] == ["order.status_change"]

    # Over HTTP the same refusals are 409s.
    error(await api.delete(f"{ZONES}/{zone.id}"), 409, "zone_in_use")
    error(await api.delete(f"{SLOTS}/{slot.id}"), 409, "slot_in_use")


# --- slots ----------------------------------------------------------------------------------------


async def test_create_and_list_slots(api: Admin) -> None:
    zone = await add_zone(api.factory, "demo-slots", ["chilonzor"])
    other = await add_zone(api.factory, "demo-other", ["olmazor"])
    response = await api.post(SLOTS, slot_body(zone.id))
    assert response.status_code == 201, response.text
    slot = response.json()
    assert slot == {
        **slot,
        "zone_id": str(zone.id),
        "slot_date": "2026-11-02",
        "starts_at": "10:00",
        "ends_at": "13:00",
        "capacity": 8,
        "reserved_count": 0,
        "remaining": 8,
        "cutoff_at": "2026-11-02T05:00:00Z",
        "is_active": True,
    }
    # The same start in Tashkent written with an offset is the same (allowed) instant.
    later = await api.post(
        SLOTS,
        slot_body(zone.id, slot_date="2026-11-03", cutoff_at="2026-11-03T10:00:00+05:00"),
    )
    assert later.status_code == 201, later.text
    await add_slot(api.factory, other, DAY, starts_at=time(9, 0), ends_at=time(10, 0))

    [audit] = [row for row in await audit_rows(api.factory) if row.entity_id == slot["id"]]
    assert audit.action == "slot.create"
    assert audit.details["changes"]["capacity"] == {"from": None, "to": 8}
    assert audit.details["changes"]["zone_id"] == {"from": None, "to": str(zone.id)}

    everything = (await api.get(SLOTS)).json()
    assert [(s["slot_date"], s["starts_at"]) for s in everything["items"]] == [
        ("2026-11-02", "09:00"),
        ("2026-11-02", "10:00"),
        ("2026-11-03", "10:00"),
    ]
    assert everything["truncated"] is False
    mine = (await api.get(SLOTS, zone_id=str(zone.id))).json()["items"]
    assert len(mine) == 2
    ranged = (await api.get(SLOTS, date_from="2026-11-03", date_to="2026-11-03")).json()["items"]
    assert [s["id"] for s in ranged] == [later.json()["id"]]
    error(
        await api.get(SLOTS, date_from="2026-11-03", date_to="2026-11-02"), 422, "validation_error"
    )
    error(await api.get(SLOTS, zone_id="nope"), 422, "validation_error")


async def test_slot_validation_and_conflicts(api: Admin) -> None:
    zone = await add_zone(api.factory, "demo-slots", ["chilonzor"])
    for body in (
        slot_body(zone.id, cutoff_at="2026-11-02T05:00:01Z"),  # one second after the start
        slot_body(zone.id, cutoff_at="2026-11-02T10:00:01+05:00"),
        slot_body(zone.id, cutoff_at="2026-11-02T04:00:00"),  # no timezone
        slot_body(zone.id, starts_at="13:00", ends_at="13:00"),
        slot_body(zone.id, starts_at="10:00:00"),
        slot_body(zone.id, capacity=-1),
        slot_body(zone.id, reserved_count=0),
    ):
        error(await api.post(SLOTS, body), 422, "validation_error")
    error(await api.post(SLOTS, slot_body(uuid.uuid4())), 404, "zone_not_found")
    assert (await api.post(SLOTS, slot_body(zone.id))).status_code == 201
    error(await api.post(SLOTS, slot_body(zone.id, ends_at="12:00")), 409, "slot_exists")
    assert [row.action for row in await audit_rows(api.factory)] == ["slot.create"]


async def test_patch_slot_rules(api: Admin) -> None:
    zone = await add_zone(api.factory, "demo-slots", ["chilonzor"])
    booked = await add_slot(api.factory, zone, DAY, capacity=5, reserved_count=3)
    path = f"{SLOTS}/{booked.id}"

    body = error(await api.patch(path, {"capacity": 2}), 409, "capacity_below_reserved")
    assert "reserved" not in body  # nothing beyond the code and message
    for change in ({"starts_at": "09:00"}, {"ends_at": "14:00"}, {"slot_date": "2026-11-03"}):
        error(await api.patch(path, change), 409, "slot_in_use")
    # Capacity down to exactly what is booked, the cutoff and the active flag may change.
    response = await api.patch(
        path, {"capacity": 3, "is_active": False, "cutoff_at": "2026-11-02T04:00:00Z"}
    )
    assert response.status_code == 200, response.text
    assert (response.json()["capacity"], response.json()["remaining"]) == (3, 0)
    assert await slot_state(api.factory, booked.id) == (3, 3)
    update = (await audit_rows(api.factory))[-1]
    assert update.action == "slot.update"
    assert set(update.details["changes"]) == {"capacity", "is_active", "cutoff_at"}
    error(await api.patch(path, {"cutoff_at": "2026-11-02T06:00:00Z"}), 422, "validation_error")

    # Nothing booked: the slot may move, as long as the cutoff stays before the new start.
    free = await add_slot(api.factory, zone, DAY, starts_at=time(15, 0), ends_at=time(18, 0))
    free_path = f"{SLOTS}/{free.id}"
    body = error(await api.patch(free_path, {"starts_at": "11:00"}), 422, "validation_error")
    assert body["details"][0]["loc"] == ["body", "cutoff_at"]  # 13:00 cutoff after an 11:00 start
    taken = {"starts_at": "10:00", "cutoff_at": "2026-11-02T04:00:00Z"}
    error(await api.patch(free_path, taken), 409, "slot_exists")
    error(await api.patch(free_path, {"ends_at": "14:00"}), 422, "validation_error")
    moved = await api.patch(
        free_path, {"slot_date": "2026-11-04", "starts_at": "16:00", "ends_at": "19:00"}
    )
    assert moved.status_code == 200, moved.text
    assert (moved.json()["slot_date"], moved.json()["starts_at"]) == ("2026-11-04", "16:00")
    for body in ({"capacity": None}, {"zone_id": str(zone.id)}, {"reserved_count": 0}):
        error(await api.patch(free_path, body), 422, "validation_error")
    error(await api.patch(f"{SLOTS}/{uuid.uuid4()}", {"capacity": 1}), 404, "slot_not_found")
    assert [row.action for row in await audit_rows(api.factory)] == ["slot.update", "slot.update"]


async def test_delete_slot(api: Admin) -> None:
    zone = await add_zone(api.factory, "demo-slots", ["chilonzor"])
    booked = await add_slot(api.factory, zone, DAY, reserved_count=1)
    error(await api.delete(f"{SLOTS}/{booked.id}"), 409, "slot_in_use")

    # Not booked any more, but a (cancelled) order still points at it.
    category = await add_category(api.factory, "slot-cat")
    product = await add_product(api.factory, category, "slot-apple", price=60_000)
    referenced = await add_slot(api.factory, zone, DAY, starts_at=time(15, 0), ends_at=time(16, 0))
    headers = {TEST_USER_HEADER: str(api.customer.id)}
    await api.client.post(
        "/api/v1/cart/items", json={"product_id": str(product.id), "quantity": 1}, headers=headers
    )
    placed = await api.client.post(
        "/api/v1/orders",
        json={**order_body(expected_total_uzs=75_000), "delivery_slot_id": str(referenced.id)},
        headers={**headers, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert placed.status_code == 201, placed.text
    cancelled = await api.client.post(
        f"/api/v1/orders/{placed.json()['id']}/cancel", json={"reason": "Demo"}, headers=headers
    )
    assert cancelled.status_code == 200
    assert await slot_state(api.factory, referenced.id) == (0, 10)
    error(await api.delete(f"{SLOTS}/{referenced.id}"), 409, "slot_in_use")

    free = await add_slot(api.factory, zone, DAY, starts_at=time(18, 0), ends_at=time(19, 0))
    assert (await api.delete(f"{SLOTS}/{free.id}")).status_code == 204
    async with api.factory() as session:
        assert await session.get(DeliverySlot, free.id) is None
    [deleted] = await audit_rows(api.factory, AuditLog.action == "slot.delete")
    assert deleted.entity_id == str(free.id)
    assert deleted.details["changes"]["starts_at"] == {"from": "18:00:00", "to": None}
    error(await api.delete(f"{SLOTS}/{free.id}"), 404, "slot_not_found")


# --- roles ----------------------------------------------------------------------------------------


async def test_operators_and_customers_are_refused_before_anything_happens(api: Admin) -> None:
    zone = await add_zone(api.factory, "demo-slots", ["chilonzor"])
    slot = await add_slot(api.factory, zone, DAY)
    for user in (api.operator, api.customer):
        requests = [
            api.get(ZONES, user),
            api.post(ZONES, zone_body(), user),
            api.patch(f"{ZONES}/{zone.id}", {"name_uz": "X"}, user),
            api.patch(f"{ZONES}/{uuid.uuid4()}", {"name_uz": "X"}, user),
            api.delete(f"{ZONES}/{zone.id}", user),
            api.get(SLOTS, user),
            api.post(SLOTS, slot_body(zone.id, starts_at="15:00", ends_at="16:00"), user),
            api.patch(f"{SLOTS}/{slot.id}", {"capacity": 1}, user),
            api.delete(f"{SLOTS}/{slot.id}", user),
            api.delete(f"{SLOTS}/{uuid.uuid4()}", user),
        ]
        for request in requests:
            response = await request
            assert response.json() == {
                "error": {"code": "forbidden", "message": "Admin role required"}
            }
            assert response.status_code == 403
    assert await audit_rows(api.factory) == []
    assert await slot_state(api.factory, slot.id) == (0, 10)
    async with api.factory() as session:
        assert (await session.get(DeliveryZone, zone.id)) is not None
    # The operator does get the dashboard.
    assert (await api.get("/api/v1/admin/dashboard", api.operator)).status_code == 200
    error(await api.get("/api/v1/admin/dashboard", api.customer), 403, "forbidden")
