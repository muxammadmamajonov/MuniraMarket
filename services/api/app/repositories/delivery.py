"""Delivery zones behind a small interface so routes can be tested without a database."""

import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.delivery import ZoneRules, match_zone
from app.models.delivery import DeliveryZone, DeliveryZoneDistrict


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
