"""Delivery zones behind a small interface so routes can be tested without a database."""

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Final, Protocol

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.delivery import ZoneRules, match_zone, tashkent_date
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict

# What the checkout quote offers: bookable slots of the next 14 local days, at most 60.
SLOT_OFFER_DAYS: Final = 14
SLOT_OFFER_LIMIT: Final = 60


@dataclass(frozen=True, slots=True)
class ZoneRecord:
    zone_id: uuid.UUID
    is_active: bool
    districts: frozenset[str]
    slug: str
    name_uz: str
    name_ru: str
    rules: ZoneRules
    sort_order: int


@dataclass(frozen=True, slots=True)
class SlotOptionRecord:
    """A delivery slot as offered at checkout (active, cutoff still ahead)."""

    id: uuid.UUID
    slot_date: date
    starts_at: time
    ends_at: time
    capacity: int
    reserved_count: int

    @property
    def remaining(self) -> int:
        return max(0, self.capacity - self.reserved_count)


class DeliveryZoneRepository(Protocol):
    async def list_active(self) -> list[ZoneRecord]:
        """Active zones in display order, each with its districts."""
        ...

    async def find_for_district(self, district: str) -> ZoneRecord | None:
        """The active zone delivering to ``district``, else ``None``."""
        ...


class SqlAlchemyDeliveryZoneRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_active(self) -> list[ZoneRecord]:
        zones = (
            await self._session.execute(
                select(DeliveryZone)
                .where(DeliveryZone.is_active.is_(True))
                .order_by(DeliveryZone.sort_order, DeliveryZone.slug)
            )
        ).scalars()
        rows = list(zones)
        districts: dict[uuid.UUID, set[str]] = defaultdict(set)
        if rows:
            mapping = await self._session.execute(
                select(DeliveryZoneDistrict.zone_id, DeliveryZoneDistrict.district).where(
                    DeliveryZoneDistrict.zone_id.in_([zone.id for zone in rows])
                )
            )
            for zone_id, district in mapping:
                districts[zone_id].add(district)
        return [to_zone_record(zone, frozenset(districts[zone.id])) for zone in rows]

    async def find_for_district(self, district: str) -> ZoneRecord | None:
        return match_zone(district, await self.list_active())

    async def has_bookable_slot(self, zone_id: uuid.UUID, now: datetime) -> bool:
        """Whether the zone has any active slot whose cutoff is still ahead (then one is
        required at checkout). Full slots count: the zone runs on slots, they are just taken."""
        return bool(
            (
                await self._session.execute(
                    select(
                        exists().where(
                            DeliverySlot.zone_id == zone_id,
                            DeliverySlot.is_active.is_(True),
                            DeliverySlot.cutoff_at > now,
                        )
                    )
                )
            ).scalar_one()
        )

    async def offered_slots(self, zone_id: uuid.UUID, now: datetime) -> list[SlotOptionRecord]:
        """Active slots with the cutoff ahead on the next ``SLOT_OFFER_DAYS`` local days,
        by date and start time (full ones included, so the customer sees them as taken)."""
        today = tashkent_date(now)
        rows = (
            await self._session.execute(
                select(
                    DeliverySlot.id,
                    DeliverySlot.slot_date,
                    DeliverySlot.starts_at,
                    DeliverySlot.ends_at,
                    DeliverySlot.capacity,
                    DeliverySlot.reserved_count,
                )
                .where(
                    DeliverySlot.zone_id == zone_id,
                    DeliverySlot.is_active.is_(True),
                    DeliverySlot.cutoff_at > now,
                    DeliverySlot.slot_date >= today,
                    DeliverySlot.slot_date < today + timedelta(days=SLOT_OFFER_DAYS),
                )
                .order_by(DeliverySlot.slot_date, DeliverySlot.starts_at, DeliverySlot.id)
                .limit(SLOT_OFFER_LIMIT)
            )
        ).all()
        return [
            SlotOptionRecord(
                id=row.id,
                slot_date=row.slot_date,
                starts_at=row.starts_at,
                ends_at=row.ends_at,
                capacity=row.capacity,
                reserved_count=row.reserved_count,
            )
            for row in rows
        ]


def to_zone_record(zone: DeliveryZone, districts: frozenset[str]) -> ZoneRecord:
    return ZoneRecord(
        zone_id=zone.id,
        is_active=zone.is_active,
        districts=districts,
        slug=zone.slug,
        name_uz=zone.name_uz,
        name_ru=zone.name_ru,
        rules=ZoneRules(
            delivery_fee_uzs=zone.delivery_fee_uzs,
            free_delivery_threshold_uzs=zone.free_delivery_threshold_uzs,
            min_order_uzs=zone.min_order_uzs,
            opens_at=zone.opens_at,
            closes_at=zone.closes_at,
        ),
        sort_order=zone.sort_order,
    )
