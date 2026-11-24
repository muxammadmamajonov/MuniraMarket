"""Asia/Tashkent local time as pure, dependency-free functions."""

from datetime import UTC, date, datetime, time, timedelta, timezone

# Asia/Tashkent is UTC+05:00 all year (no daylight saving since 1992). A fixed offset avoids a
# dependency on the host's tz database inside slim container images.
TASHKENT_TZ = timezone(timedelta(hours=5), "Asia/Tashkent")


def utc_now_from(timestamp: float) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=UTC)


def tashkent_date(moment: datetime) -> date:
    """The local (Asia/Tashkent) calendar date of a timezone-aware instant."""
    if moment.tzinfo is None:
        raise ValueError("moment must be timezone-aware")
    return moment.astimezone(TASHKENT_TZ).date()


def tashkent_instant(day: date, at: time) -> datetime:
    """The instant of local (Asia/Tashkent) wall-clock time ``at`` on ``day``."""
    return datetime.combine(day, at, tzinfo=TASHKENT_TZ)
