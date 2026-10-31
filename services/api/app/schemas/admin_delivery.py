"""Admin request/response models for delivery zones and delivery slots.

Times are local Asia/Tashkent wall-clock ``HH:MM``; slot dates are local calendar dates; money is
integer UZS. Request models forbid unknown fields; ``PATCH`` bodies apply only the fields that
were sent (an omitted field is left alone, and ``null`` is accepted only where it means
something, e.g. "never free" for ``free_delivery_threshold_uzs``).
"""

import re
import uuid
from datetime import date, datetime, time
from typing import Annotated, Any, Final, Self

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from app.domain.delivery import DistrictCode, slot_cutoff_is_valid
from app.domain.text import INVISIBLE_TEXT_MESSAGE, has_invisible_characters
from app.repositories.admin_delivery import AdminSlotRecord, AdminZoneRecord
from app.schemas.delivery import District, hhmm

SLUG_PATTERN: Final = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
HHMM_PATTERN: Final = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"
MAX_MONEY_UZS: Final = 10**12
MAX_SORT_ORDER: Final = 100_000
MAX_SLOT_CAPACITY: Final = 10_000

_HHMM = re.compile(HHMM_PATTERN)
_CONTROL_OR_NEWLINE = re.compile(r"[\x00-\x1f\x7f]")


def _parse_hhmm(value: object) -> object:
    """Accept exactly ``HH:MM`` (no seconds, no other formats) and turn it into a ``time``."""
    if isinstance(value, str) and _HHMM.fullmatch(value):
        return time.fromisoformat(value)
    raise ValueError("must be a time as HH:MM (00:00-23:59)")


def _single_line(value: str) -> str:
    if _CONTROL_OR_NEWLINE.search(value):
        raise ValueError("must be a single line of text")
    if has_invisible_characters(value):
        raise ValueError(INVISIBLE_TEXT_MESSAGE)
    return value


ClockTime = Annotated[
    time,
    BeforeValidator(_parse_hhmm),
    WithJsonSchema({"type": "string", "pattern": HHMM_PATTERN, "examples": ["09:00"]}),
]
Slug = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=SLUG_PATTERN),
]
Name = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=255),
    AfterValidator(_single_line),
]
Money = Annotated[int, Field(ge=0, le=MAX_MONEY_UZS)]
SortOrder = Annotated[int, Field(ge=-MAX_SORT_ORDER, le=MAX_SORT_ORDER)]
Capacity = Annotated[int, Field(ge=0, le=MAX_SLOT_CAPACITY)]


def _unique_districts(value: list[DistrictCode]) -> list[DistrictCode]:
    if len(set(value)) != len(value):
        raise ValueError("districts must not repeat")
    return value


Districts = Annotated[
    list[DistrictCode], Field(min_length=1, max_length=12), AfterValidator(_unique_districts)
]


def _reject_null(fields: tuple[str, ...]) -> Any:
    """A ``PATCH`` field that may be omitted but not set to ``null``."""

    def check(value: object) -> object:
        if value is None:
            raise ValueError("may be omitted but not null")
        return value

    return field_validator(*fields)(check)


# --- zones ----------------------------------------------------------------------------------------


class ZoneCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: Slug
    name_uz: Name
    name_ru: Name
    delivery_fee_uzs: Money
    # ``null``: delivery is never free in this zone.
    free_delivery_threshold_uzs: Money | None = None
    min_order_uzs: Money = 0
    opens_at: ClockTime
    closes_at: ClockTime
    sort_order: SortOrder = 0
    is_active: bool = True
    districts: Districts

    @model_validator(mode="after")
    def _hours_ordered(self) -> Self:
        if self.opens_at >= self.closes_at:
            raise ValueError("opens_at must be before closes_at")
        return self


class ZoneUpdateRequest(BaseModel):
    """Only the fields sent are changed; ``districts`` replaces the whole set."""

    model_config = ConfigDict(extra="forbid")

    slug: Slug | None = None
    name_uz: Name | None = None
    name_ru: Name | None = None
    delivery_fee_uzs: Money | None = None
    free_delivery_threshold_uzs: Money | None = None
    min_order_uzs: Money | None = None
    opens_at: ClockTime | None = None
    closes_at: ClockTime | None = None
    sort_order: SortOrder | None = None
    is_active: bool | None = None
    districts: Districts | None = None

    _not_null = _reject_null(
        (
            "slug",
            "name_uz",
            "name_ru",
            "delivery_fee_uzs",
            "min_order_uzs",
            "opens_at",
            "closes_at",
            "sort_order",
            "is_active",
            "districts",
        )
    )

    def changes(self) -> dict[str, Any]:
        """The sent fields with their (validated) values; districts as a frozenset."""
        values: dict[str, Any] = {
            field: getattr(self, field) for field in sorted(self.model_fields_set)
        }
        if "districts" in values:
            values["districts"] = frozenset(values["districts"])
        return values


class DeliveryZoneAdmin(BaseModel):
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str
    delivery_fee_uzs: int
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    # ``HH:MM`` in Asia/Tashkent.
    opens_at: str
    closes_at: str
    sort_order: int
    is_active: bool
    districts: list[District]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, zone: AdminZoneRecord) -> Self:
        return cls(
            id=zone.id,
            slug=zone.slug,
            name_uz=zone.name_uz,
            name_ru=zone.name_ru,
            delivery_fee_uzs=zone.delivery_fee_uzs,
            free_delivery_threshold_uzs=zone.free_delivery_threshold_uzs,
            min_order_uzs=zone.min_order_uzs,
            opens_at=hhmm(zone.opens_at),
            closes_at=hhmm(zone.closes_at),
            sort_order=zone.sort_order,
            is_active=zone.is_active,
            districts=[District.from_code(code) for code in zone.district_codes()],
            created_at=zone.created_at,
            updated_at=zone.updated_at,
        )


class DeliveryZoneAdminList(BaseModel):
    items: list[DeliveryZoneAdmin]


# --- slots ----------------------------------------------------------------------------------------


class SlotCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zone_id: uuid.UUID
    # Local Asia/Tashkent calendar date.
    slot_date: date
    starts_at: ClockTime
    ends_at: ClockTime
    capacity: Capacity
    # Orders are accepted strictly before this instant; it may not be after the slot starts.
    cutoff_at: AwareDatetime
    is_active: bool = True

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.starts_at >= self.ends_at:
            raise ValueError("starts_at must be before ends_at")
        if not slot_cutoff_is_valid(self.slot_date, self.starts_at, self.cutoff_at):
            raise ValueError("cutoff_at must not be after the slot starts")
        return self


class SlotUpdateRequest(BaseModel):
    """Only the fields sent are changed. Date and times can change only while nothing is booked;
    capacity cannot drop below what is already booked."""

    model_config = ConfigDict(extra="forbid")

    slot_date: date | None = None
    starts_at: ClockTime | None = None
    ends_at: ClockTime | None = None
    capacity: Capacity | None = None
    cutoff_at: AwareDatetime | None = None
    is_active: bool | None = None

    _not_null = _reject_null(
        ("slot_date", "starts_at", "ends_at", "capacity", "cutoff_at", "is_active")
    )

    def changes(self) -> dict[str, Any]:
        return {field: getattr(self, field) for field in sorted(self.model_fields_set)}


class DeliverySlotAdmin(BaseModel):
    id: uuid.UUID
    zone_id: uuid.UUID
    slot_date: date
    # ``HH:MM`` in Asia/Tashkent.
    starts_at: str
    ends_at: str
    capacity: int
    reserved_count: int
    remaining: int
    cutoff_at: datetime
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, slot: AdminSlotRecord) -> Self:
        return cls(
            id=slot.id,
            zone_id=slot.zone_id,
            slot_date=slot.slot_date,
            starts_at=hhmm(slot.starts_at),
            ends_at=hhmm(slot.ends_at),
            capacity=slot.capacity,
            reserved_count=slot.reserved_count,
            remaining=max(0, slot.capacity - slot.reserved_count),
            cutoff_at=slot.cutoff_at,
            is_active=slot.is_active,
            created_at=slot.created_at,
            updated_at=slot.updated_at,
        )


class DeliverySlotAdminList(BaseModel):
    items: list[DeliverySlotAdmin]
    # True when more slots match than ``MAX_SLOT_LIST`` (narrow the date range).
    truncated: bool
