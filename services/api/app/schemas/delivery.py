"""Delivery zone response models. Money is integer UZS; hours are local Asia/Tashkent time."""

import datetime as dt
import uuid
from datetime import datetime, time
from typing import Literal, Self

from pydantic import BaseModel

from app.domain.delivery import DISTRICT_NAMES, DistrictCode, is_open_at
from app.repositories.delivery import SlotOptionRecord, ZoneRecord


class District(BaseModel):
    code: DistrictCode
    name_uz: str
    name_ru: str

    @classmethod
    def from_code(cls, code: DistrictCode) -> Self:
        names = DISTRICT_NAMES[code]
        return cls(code=code, name_uz=names.uz, name_ru=names.ru)


def hhmm(value: time) -> str:
    return value.strftime("%H:%M")


class DeliveryZonePublic(BaseModel):
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str
    delivery_fee_uzs: int
    # ``null``: delivery is never free in this zone.
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    # ``HH:MM`` in Asia/Tashkent. Orders are accepted around the clock; outside these hours they
    # are delivered from the next opening.
    opens_at: str
    closes_at: str
    is_open_now: bool
    districts: list[District]

    @classmethod
    def from_record(cls, zone: ZoneRecord, now: datetime) -> Self:
        return cls(
            id=zone.zone_id,
            slug=zone.slug,
            name_uz=zone.name_uz,
            name_ru=zone.name_ru,
            delivery_fee_uzs=zone.rules.delivery_fee_uzs,
            free_delivery_threshold_uzs=zone.rules.free_delivery_threshold_uzs,
            min_order_uzs=zone.rules.min_order_uzs,
            opens_at=hhmm(zone.rules.opens_at),
            closes_at=hhmm(zone.rules.closes_at),
            is_open_now=is_open_at(zone.rules, now),
            districts=[
                District.from_code(code)
                for code in DISTRICT_NAMES  # stable, documented order
                if code in zone.districts
            ],
        )


class DeliveryZoneList(BaseModel):
    items: list[DeliveryZonePublic]
    timezone: Literal["Asia/Tashkent"] = "Asia/Tashkent"


class DeliverySlotOption(BaseModel):
    """A bookable delivery window offered at checkout (local Asia/Tashkent date and times)."""

    id: uuid.UUID
    date: dt.date
    # ``HH:MM`` in Asia/Tashkent.
    starts_at: str
    ends_at: str
    remaining: int
    is_full: bool

    @classmethod
    def from_record(cls, slot: SlotOptionRecord) -> Self:
        return cls(
            id=slot.id,
            date=slot.slot_date,
            starts_at=hhmm(slot.starts_at),
            ends_at=hhmm(slot.ends_at),
            remaining=slot.remaining,
            is_full=slot.remaining == 0,
        )
