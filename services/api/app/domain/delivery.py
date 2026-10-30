"""Tashkent delivery zones and pricing as pure, dependency-free functions.

Zones are matched by district (no geocoding): every Tashkent district belongs to at most one zone,
and only active zones deliver. Money is integer UZS. Working hours are local ``Asia/Tashkent`` time.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta, timezone
from typing import Literal, Protocol, get_args

# Asia/Tashkent is UTC+05:00 all year (no daylight saving since 1992). A fixed offset avoids a
# dependency on the host's tz database inside slim container images.
TASHKENT_TZ = timezone(timedelta(hours=5), "Asia/Tashkent")

DistrictCode = Literal[
    "bektemir",
    "chilonzor",
    "mirobod",
    "mirzo_ulugbek",
    "olmazor",
    "sergeli",
    "shayxontohur",
    "uchtepa",
    "yakkasaroy",
    "yangihayot",
    "yashnobod",
    "yunusobod",
]

DISTRICT_CODES: tuple[DistrictCode, ...] = get_args(DistrictCode)


@dataclass(frozen=True, slots=True)
class DistrictName:
    uz: str
    ru: str


# The twelve districts (tumanlar) of Tashkent city.
DISTRICT_NAMES: dict[DistrictCode, DistrictName] = {
    "bektemir": DistrictName("Bektemir", "Бектемирский"),
    "chilonzor": DistrictName("Chilonzor", "Чиланзарский"),
    "mirobod": DistrictName("Mirobod", "Мирабадский"),
    "mirzo_ulugbek": DistrictName("Mirzo Ulug\u2018bek", "Мирзо-Улугбекский"),
    "olmazor": DistrictName("Olmazor", "Алмазарский"),
    "sergeli": DistrictName("Sergeli", "Сергелийский"),
    "shayxontohur": DistrictName("Shayxontohur", "Шайхантахурский"),
    "uchtepa": DistrictName("Uchtepa", "Учтепинский"),
    "yakkasaroy": DistrictName("Yakkasaroy", "Яккасарайский"),
    "yangihayot": DistrictName("Yangihayot", "Янгихаётский"),
    "yashnobod": DistrictName("Yashnobod", "Яшнабадский"),
    "yunusobod": DistrictName("Yunusobod", "Юнусабадский"),
}


def is_district_code(value: str) -> bool:
    return value in DISTRICT_NAMES


@dataclass(frozen=True, slots=True)
class ZoneRules:
    """The pricing and schedule facts of one zone."""

    delivery_fee_uzs: int
    # ``None``: delivery is never free in this zone.
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    # Local Asia/Tashkent time; ``opens_at < closes_at`` (no overnight windows).
    opens_at: time
    closes_at: time


class ZoneCandidate(Protocol):
    """What zone matching needs to know about a zone."""

    @property
    def is_active(self) -> bool: ...

    @property
    def districts(self) -> frozenset[str]: ...


def match_zone[Z: ZoneCandidate](district: str, zones: Sequence[Z]) -> Z | None:
    """The active zone covering ``district``, or ``None`` when no active zone delivers there."""
    for zone in zones:
        if zone.is_active and district in zone.districts:
            return zone
    return None


def delivery_fee_for(rules: ZoneRules, subtotal_uzs: int) -> int:
    """Free once the subtotal reaches the zone's threshold, otherwise the zone's flat fee."""
    threshold = rules.free_delivery_threshold_uzs
    if threshold is not None and subtotal_uzs >= threshold:
        return 0
    return rules.delivery_fee_uzs


def free_delivery_remaining(rules: ZoneRules, subtotal_uzs: int) -> int | None:
    """How much more to spend for free delivery; ``0`` once reached, ``None`` if never free."""
    threshold = rules.free_delivery_threshold_uzs
    if threshold is None:
        return None
    return max(0, threshold - subtotal_uzs)


def is_open_at(rules: ZoneRules, moment: datetime) -> bool:
    """Whether ``moment`` (any timezone-aware instant) falls within the zone's local hours."""
    if moment.tzinfo is None:
        raise ValueError("moment must be timezone-aware")
    local = moment.astimezone(TASHKENT_TZ).time()
    return rules.opens_at <= local < rules.closes_at


def utc_now_from(timestamp: float) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=UTC)
