"""Map points (WGS84) of delivery addresses."""

import math
from dataclasses import dataclass
from typing import Any

# Stored and compared with 6 decimal places (about 0.1 m), as in the Yandex Go courier link.
COORDINATE_DECIMALS = 6


@dataclass(frozen=True, slots=True)
class GeoPoint:
    lat: float
    lon: float


def _coordinate(value: object, limit: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) and -limit <= number <= limit else None


def snapshot_point(address: Any) -> GeoPoint | None:
    """The point of a stored ``address_snapshot``, or ``None`` when it has no valid coordinates.

    Orders placed before courier delivery have none (their snapshot has the old address shape,
    whose other keys are ignored)."""
    if not isinstance(address, dict):
        return None
    lat = _coordinate(address.get("lat"), 90)
    lon = _coordinate(address.get("lon"), 180)
    if lat is None or lon is None:
        return None
    return GeoPoint(lat=lat, lon=lon)
