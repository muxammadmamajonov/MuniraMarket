"""Admin management of delivery zones and delivery slots, with an audit row per change.

Every write is one transaction that also adds its ``zone.*`` / ``slot.*`` audit row, so a change
and its audit entry commit (or roll back) together. Rows are locked ``FOR UPDATE`` before they
are checked and changed: a zone before its districts are replaced or it is deleted; a slot before
its capacity, times or state change. Order creation books a slot with a conditional ``UPDATE`` on
the same row, so a capacity change and a booking serialise (neither can leave
``reserved_count > capacity``; the CHECK constraint is the backstop).
"""

import uuid
from collections import defaultdict
from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Final, Protocol

from sqlalchemy import delete, exists, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditActor, AuditEntity, diff_fields, record_audit
from app.domain.delivery import DISTRICT_NAMES, slot_cutoff_is_valid
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict
from app.models.order import Order

# The admin slot list returns at most this many rows (narrow the filters for more).
MAX_SLOT_LIST: Final = 1000

ZONE_SLUG_CONSTRAINT: Final = "uq_delivery_zones_slug"
SLOT_UNIQUE_CONSTRAINT: Final = "uq_delivery_slots_zone_id_slot_date_starts_at"

ZONE_FIELDS: Final = (
    "slug",
    "name_uz",
    "name_ru",
    "delivery_fee_uzs",
    "free_delivery_threshold_uzs",
    "min_order_uzs",
    "opens_at",
    "closes_at",
    "sort_order",
    "is_active",
)
SLOT_FIELDS: Final = ("slot_date", "starts_at", "ends_at", "capacity", "cutoff_at", "is_active")
# A slot's place in time; changing it would move customers who already booked it.
SLOT_TIME_FIELDS: Final = frozenset({"slot_date", "starts_at", "ends_at"})


# --- errors ---------------------------------------------------------------------------------------


class AdminDeliveryError(Exception):
    """Base class for refused zone/slot changes."""


class ZoneNotFoundError(AdminDeliveryError):
    pass


class SlotNotFoundError(AdminDeliveryError):
    pass


class ZoneSlugTakenError(AdminDeliveryError):
    pass


class DistrictTakenError(AdminDeliveryError):
    def __init__(self, district: str) -> None:
        super().__init__(f"district {district} belongs to another zone")
        self.district = district


class ZoneInUseError(AdminDeliveryError):
    """Orders or slots reference the zone: deactivate it instead of deleting."""


class SlotExistsError(AdminDeliveryError):
    """The zone already has a slot starting at that date and time."""


class SlotInUseError(AdminDeliveryError):
    """Places are booked (or orders reference the slot): it cannot be moved or deleted."""


class CapacityBelowReservedError(AdminDeliveryError):
    def __init__(self, reserved_count: int) -> None:
        super().__init__(f"{reserved_count} places are already booked")
        self.reserved_count = reserved_count


class InvalidValueError(AdminDeliveryError):
    """The merged result of a partial update is inconsistent (reported as a 422)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


# --- records --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AdminZoneRecord:
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str
    delivery_fee_uzs: int
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    opens_at: time
    closes_at: time
    sort_order: int
    is_active: bool
    districts: frozenset[str]
    created_at: datetime
    updated_at: datetime

    def district_codes(self) -> list[Any]:
        """District codes in the documented, stable order."""
        return [code for code in DISTRICT_NAMES if code in self.districts]


@dataclass(frozen=True, slots=True)
class AdminSlotRecord:
    id: uuid.UUID
    zone_id: uuid.UUID
    slot_date: date
    starts_at: time
    ends_at: time
    capacity: int
    reserved_count: int
    cutoff_at: datetime
    is_active: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SlotListRecord:
    items: tuple[AdminSlotRecord, ...]
    truncated: bool


class AdminDeliveryRepository(Protocol):
    """Refusals raise the ``AdminDeliveryError`` subclasses above."""

    async def list_zones(self) -> list[AdminZoneRecord]: ...

    async def create_zone(
        self, values: Mapping[str, Any], districts: frozenset[str], *, actor: AuditActor
    ) -> AdminZoneRecord: ...

    async def update_zone(
        self, zone_id: uuid.UUID, changes: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminZoneRecord: ...

    async def delete_zone(self, zone_id: uuid.UUID, *, actor: AuditActor) -> None: ...

    async def list_slots(
        self, *, zone_id: uuid.UUID | None, date_from: date | None, date_to: date | None
    ) -> SlotListRecord: ...

    async def create_slot(
        self, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminSlotRecord: ...

    async def update_slot(
        self, slot_id: uuid.UUID, changes: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminSlotRecord: ...

    async def delete_slot(self, slot_id: uuid.UUID, *, actor: AuditActor) -> None: ...


# --- helpers --------------------------------------------------------------------------------------


def _constraint(error: IntegrityError) -> str | None:
    name = getattr(getattr(error.orig, "__cause__", None), "constraint_name", None)
    if name is None:
        name = getattr(error.orig, "constraint_name", None)
    return name if isinstance(name, str) else None


def _zone_record(zone: DeliveryZone, districts: Iterable[str]) -> AdminZoneRecord:
    return AdminZoneRecord(
        id=zone.id,
        slug=zone.slug,
        name_uz=zone.name_uz,
        name_ru=zone.name_ru,
        delivery_fee_uzs=zone.delivery_fee_uzs,
        free_delivery_threshold_uzs=zone.free_delivery_threshold_uzs,
        min_order_uzs=zone.min_order_uzs,
        opens_at=zone.opens_at,
        closes_at=zone.closes_at,
        sort_order=zone.sort_order,
        is_active=zone.is_active,
        districts=frozenset(districts),
        created_at=zone.created_at,
        updated_at=zone.updated_at,
    )


def _slot_record(slot: DeliverySlot) -> AdminSlotRecord:
    return AdminSlotRecord(
        id=slot.id,
        zone_id=slot.zone_id,
        slot_date=slot.slot_date,
        starts_at=slot.starts_at,
        ends_at=slot.ends_at,
        capacity=slot.capacity,
        reserved_count=slot.reserved_count,
        cutoff_at=slot.cutoff_at,
        is_active=slot.is_active,
        created_at=slot.created_at,
        updated_at=slot.updated_at,
    )


def _zone_values(zone: DeliveryZone) -> dict[str, Any]:
    return {field: getattr(zone, field) for field in ZONE_FIELDS}


def _slot_values(slot: DeliverySlot) -> dict[str, Any]:
    return {field: getattr(slot, field) for field in SLOT_FIELDS}


def check_slot_values(values: Mapping[str, Any]) -> None:
    """The rules a slot must satisfy as a whole (also after a partial update)."""
    if values["starts_at"] >= values["ends_at"]:
        raise InvalidValueError("ends_at", "starts_at must be before ends_at")
    if not slot_cutoff_is_valid(values["slot_date"], values["starts_at"], values["cutoff_at"]):
        raise InvalidValueError("cutoff_at", "cutoff_at must not be after the slot starts")


# --- SQLAlchemy implementation --------------------------------------------------------------------


class SqlAlchemyAdminDeliveryRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    # --- zones -----------------------------------------------------------------------------------

    async def list_zones(self) -> list[AdminZoneRecord]:
        zones = list(
            (
                await self._session.execute(
                    select(DeliveryZone).order_by(DeliveryZone.sort_order, DeliveryZone.slug)
                )
            ).scalars()
        )
        districts = await self._districts_of([zone.id for zone in zones])
        return [_zone_record(zone, districts[zone.id]) for zone in zones]

    async def create_zone(
        self, values: Mapping[str, Any], districts: frozenset[str], *, actor: AuditActor
    ) -> AdminZoneRecord:
        async with self._transaction():
            await self._ensure_slug_free(values["slug"], None)
            zone = DeliveryZone(**{field: values[field] for field in ZONE_FIELDS})
            try:
                async with self._session.begin_nested():
                    self._session.add(zone)
                    await self._session.flush()
            except IntegrityError as error:
                if _constraint(error) == ZONE_SLUG_CONSTRAINT:
                    raise ZoneSlugTakenError() from None
                raise
            await self._claim_districts(zone.id, districts)
            record_audit(
                self._session,
                actor,
                action="zone.create",
                entity_type=AuditEntity.ZONE,
                entity_id=zone.id,
                changes={
                    **{field: (None, value) for field, value in _zone_values(zone).items()},
                    "districts": (None, sorted(districts)),
                },
                extra={"slug": zone.slug, "district_count": len(districts)},
            )
            await self._session.flush()
            return await self._load_zone(zone.id)

    async def update_zone(
        self, zone_id: uuid.UUID, changes: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminZoneRecord:
        async with self._transaction():
            zone = await self._lock_zone(zone_id)
            before = _zone_values(zone)
            after = {**before, **{k: v for k, v in changes.items() if k in ZONE_FIELDS}}
            if after["opens_at"] >= after["closes_at"]:
                raise InvalidValueError("closes_at", "opens_at must be before closes_at")
            if after["slug"] != before["slug"]:
                await self._ensure_slug_free(after["slug"], zone_id)
            old_districts = frozenset((await self._districts_of([zone_id]))[zone_id])
            new_districts = frozenset(changes.get("districts", old_districts))

            field_changes: dict[str, tuple[object, object]] = diff_fields(before, after)
            if field_changes:
                for field, (_, value) in field_changes.items():
                    setattr(zone, field, value)
                try:
                    async with self._session.begin_nested():
                        await self._session.flush()
                except IntegrityError as error:
                    if _constraint(error) == ZONE_SLUG_CONSTRAINT:
                        raise ZoneSlugTakenError() from None
                    raise
            if new_districts != old_districts:
                await self._session.execute(
                    delete(DeliveryZoneDistrict).where(
                        DeliveryZoneDistrict.zone_id == zone_id,
                        DeliveryZoneDistrict.district.not_in(new_districts),
                    )
                )
                await self._claim_districts(zone_id, new_districts - old_districts)
                field_changes["districts"] = (sorted(old_districts), sorted(new_districts))
            if field_changes:
                record_audit(
                    self._session,
                    actor,
                    action="zone.update",
                    entity_type=AuditEntity.ZONE,
                    entity_id=zone_id,
                    changes=field_changes,
                    extra={"slug": after["slug"], "district_count": len(new_districts)},
                )
                await self._session.flush()
            return await self._load_zone(zone_id)

    async def delete_zone(self, zone_id: uuid.UUID, *, actor: AuditActor) -> None:
        async with self._transaction():
            zone = await self._lock_zone(zone_id)
            referenced = (
                await self._session.execute(
                    select(
                        exists().where(Order.delivery_zone_id == zone_id)
                        | exists().where(DeliverySlot.zone_id == zone_id)
                    )
                )
            ).scalar_one()
            if referenced:
                raise ZoneInUseError()
            slug = zone.slug
            await self._session.execute(delete(DeliveryZone).where(DeliveryZone.id == zone_id))
            record_audit(
                self._session,
                actor,
                action="zone.delete",
                entity_type=AuditEntity.ZONE,
                entity_id=zone_id,
                extra={"slug": slug},
            )

    async def _lock_zone(self, zone_id: uuid.UUID) -> DeliveryZone:
        zone = (
            await self._session.execute(
                select(DeliveryZone)
                .where(DeliveryZone.id == zone_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if zone is None:
            raise ZoneNotFoundError()
        return zone

    async def _ensure_slug_free(self, slug: str, zone_id: uuid.UUID | None) -> None:
        statement = select(DeliveryZone.id).where(DeliveryZone.slug == slug)
        if zone_id is not None:
            statement = statement.where(DeliveryZone.id != zone_id)
        if (await self._session.execute(statement)).first() is not None:
            raise ZoneSlugTakenError()

    async def _claim_districts(self, zone_id: uuid.UUID, districts: frozenset[str]) -> None:
        """Attach ``districts`` to the zone; any already in another zone is ``district_taken``.

        ``INSERT ... ON CONFLICT DO NOTHING``: the district primary key decides between two
        concurrent admins, and the loser learns which district it lost.
        """
        if not districts:
            return
        taken = (
            (
                await self._session.execute(
                    select(DeliveryZoneDistrict.district)
                    .where(
                        DeliveryZoneDistrict.district.in_(districts),
                        DeliveryZoneDistrict.zone_id != zone_id,
                    )
                    .order_by(DeliveryZoneDistrict.district)
                )
            )
            .scalars()
            .first()
        )
        if taken is not None:
            raise DistrictTakenError(taken)
        statement = (
            insert(DeliveryZoneDistrict)
            .values([{"district": code, "zone_id": zone_id} for code in sorted(districts)])
            .on_conflict_do_nothing(index_elements=[DeliveryZoneDistrict.district])
            .returning(DeliveryZoneDistrict.district)
        )
        inserted = set((await self._session.execute(statement)).scalars())
        lost = sorted(districts - inserted)
        if lost:
            raise DistrictTakenError(lost[0])

    async def _districts_of(self, zone_ids: list[uuid.UUID]) -> dict[uuid.UUID, set[str]]:
        districts: dict[uuid.UUID, set[str]] = defaultdict(set)
        if zone_ids:
            rows = await self._session.execute(
                select(DeliveryZoneDistrict.zone_id, DeliveryZoneDistrict.district).where(
                    DeliveryZoneDistrict.zone_id.in_(zone_ids)
                )
            )
            for zone_id, district in rows:
                districts[zone_id].add(district)
        return districts

    async def _load_zone(self, zone_id: uuid.UUID) -> AdminZoneRecord:
        zone = (
            await self._session.execute(
                select(DeliveryZone)
                .where(DeliveryZone.id == zone_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        return _zone_record(zone, (await self._districts_of([zone_id]))[zone_id])

    # --- slots -----------------------------------------------------------------------------------

    async def list_slots(
        self, *, zone_id: uuid.UUID | None, date_from: date | None, date_to: date | None
    ) -> SlotListRecord:
        conditions = []
        if zone_id is not None:
            conditions.append(DeliverySlot.zone_id == zone_id)
        if date_from is not None:
            conditions.append(DeliverySlot.slot_date >= date_from)
        if date_to is not None:
            conditions.append(DeliverySlot.slot_date <= date_to)
        rows = list(
            (
                await self._session.execute(
                    select(DeliverySlot)
                    .where(*conditions)
                    .order_by(
                        DeliverySlot.slot_date,
                        DeliverySlot.starts_at,
                        DeliverySlot.zone_id,
                        DeliverySlot.id,
                    )
                    .limit(MAX_SLOT_LIST + 1)
                )
            ).scalars()
        )
        return SlotListRecord(
            items=tuple(_slot_record(slot) for slot in rows[:MAX_SLOT_LIST]),
            truncated=len(rows) > MAX_SLOT_LIST,
        )

    async def create_slot(self, values: Mapping[str, Any], *, actor: AuditActor) -> AdminSlotRecord:
        async with self._transaction():
            zone_exists = (
                await self._session.execute(
                    select(DeliveryZone.id).where(DeliveryZone.id == values["zone_id"])
                )
            ).first()
            if zone_exists is None:
                raise ZoneNotFoundError()
            check_slot_values(values)
            slot = DeliverySlot(
                zone_id=values["zone_id"],
                **{field: values[field] for field in SLOT_FIELDS},
            )
            try:
                async with self._session.begin_nested():
                    self._session.add(slot)
                    await self._session.flush()
            except IntegrityError as error:
                if _constraint(error) == SLOT_UNIQUE_CONSTRAINT:
                    raise SlotExistsError() from None
                raise
            record_audit(
                self._session,
                actor,
                action="slot.create",
                entity_type=AuditEntity.SLOT,
                entity_id=slot.id,
                changes={
                    "zone_id": (None, slot.zone_id),
                    **{field: (None, value) for field, value in _slot_values(slot).items()},
                },
            )
            await self._session.flush()
            return await self._load_slot(slot.id)

    async def update_slot(
        self, slot_id: uuid.UUID, changes: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminSlotRecord:
        async with self._transaction():
            slot = await self._lock_slot(slot_id)
            before = _slot_values(slot)
            after = {**before, **{k: v for k, v in changes.items() if k in SLOT_FIELDS}}
            field_changes = diff_fields(before, after)
            if not field_changes:
                return _slot_record(slot)
            if after["capacity"] < slot.reserved_count:
                raise CapacityBelowReservedError(slot.reserved_count)
            if SLOT_TIME_FIELDS & set(field_changes) and slot.reserved_count > 0:
                raise SlotInUseError()
            check_slot_values(after)
            for field, (_, value) in field_changes.items():
                setattr(slot, field, value)
            try:
                async with self._session.begin_nested():
                    await self._session.flush()
            except IntegrityError as error:
                if _constraint(error) == SLOT_UNIQUE_CONSTRAINT:
                    raise SlotExistsError() from None
                raise
            record_audit(
                self._session,
                actor,
                action="slot.update",
                entity_type=AuditEntity.SLOT,
                entity_id=slot_id,
                changes=field_changes,
            )
            await self._session.flush()
            return await self._load_slot(slot_id)

    async def delete_slot(self, slot_id: uuid.UUID, *, actor: AuditActor) -> None:
        async with self._transaction():
            slot = await self._lock_slot(slot_id)
            referenced = (
                await self._session.execute(
                    select(exists().where(Order.delivery_slot_id == slot_id))
                )
            ).scalar_one()
            if slot.reserved_count > 0 or referenced:
                raise SlotInUseError()
            removed = {
                "zone_id": (slot.zone_id, None),
                **{field: (value, None) for field, value in _slot_values(slot).items()},
            }
            await self._session.execute(delete(DeliverySlot).where(DeliverySlot.id == slot_id))
            record_audit(
                self._session,
                actor,
                action="slot.delete",
                entity_type=AuditEntity.SLOT,
                entity_id=slot_id,
                changes=removed,
            )

    async def _lock_slot(self, slot_id: uuid.UUID) -> DeliverySlot:
        slot = (
            await self._session.execute(
                select(DeliverySlot)
                .where(DeliverySlot.id == slot_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if slot is None:
            raise SlotNotFoundError()
        return slot

    async def _load_slot(self, slot_id: uuid.UUID) -> AdminSlotRecord:
        slot = (
            await self._session.execute(
                select(DeliverySlot)
                .where(DeliverySlot.id == slot_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        return _slot_record(slot)


__all__ = [
    "AdminDeliveryError",
    "AdminDeliveryRepository",
    "AdminSlotRecord",
    "AdminZoneRecord",
    "CapacityBelowReservedError",
    "DistrictTakenError",
    "InvalidValueError",
    "SlotExistsError",
    "SlotInUseError",
    "SlotListRecord",
    "SlotNotFoundError",
    "SqlAlchemyAdminDeliveryRepository",
    "ZoneInUseError",
    "ZoneNotFoundError",
    "ZoneSlugTakenError",
]
