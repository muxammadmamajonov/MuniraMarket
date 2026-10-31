"""Pure checkout rules: delivery zones and fees, working hours, the quote and phone numbers."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta, timezone

import pytest

from app.domain.cart import LineFacts
from app.domain.checkout import build_quote, normalize_uz_phone
from app.domain.delivery import (
    DISTRICT_CODES,
    DISTRICT_NAMES,
    TASHKENT_TZ,
    ZoneRules,
    delivery_fee_for,
    free_delivery_remaining,
    is_district_code,
    is_open_at,
    match_zone,
    utc_now_from,
)
from app.domain.order_status import OrderStatus, customer_can_cancel
from app.repositories.orders import new_order_number


def rules(**overrides: object) -> ZoneRules:
    values: dict[str, object] = {
        "delivery_fee_uzs": 15_000,
        "free_delivery_threshold_uzs": 300_000,
        "min_order_uzs": 50_000,
        "opens_at": time(9, 0),
        "closes_at": time(21, 0),
    }
    values.update(overrides)
    return ZoneRules(**values)  # type: ignore[arg-type]


@dataclass(frozen=True)
class Zone:
    name: str
    is_active: bool
    districts: frozenset[str]


# --- districts ------------------------------------------------------------------------------------


def test_twelve_districts_each_with_both_names() -> None:
    assert len(DISTRICT_CODES) == 12
    assert set(DISTRICT_CODES) == set(DISTRICT_NAMES)
    for names in DISTRICT_NAMES.values():
        assert names.uz
        assert names.ru
    assert is_district_code("chilonzor")
    assert not is_district_code("Chilonzor")
    assert not is_district_code("tashkent")


# --- zone matching --------------------------------------------------------------------------------


def test_match_zone_finds_the_active_zone_for_a_district() -> None:
    centre = Zone("centre", True, frozenset({"mirobod", "yunusobod"}))
    edge = Zone("edge", True, frozenset({"chilonzor"}))
    assert match_zone("chilonzor", [centre, edge]) is edge
    assert match_zone("mirobod", [centre, edge]) is centre
    assert match_zone("sergeli", [centre, edge]) is None
    assert match_zone("chilonzor", []) is None


def test_match_zone_ignores_inactive_zones() -> None:
    closed = Zone("closed", False, frozenset({"bektemir"}))
    assert match_zone("bektemir", [closed]) is None
    # Even if an (inconsistent) inactive zone lists it first, the active one wins.
    open_zone = Zone("open", True, frozenset({"bektemir"}))
    assert match_zone("bektemir", [closed, open_zone]) is open_zone


# --- fees -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("subtotal", "fee", "remaining"),
    [
        (0, 15_000, 300_000),
        (50_000, 15_000, 250_000),
        (299_999, 15_000, 1),
        (300_000, 0, 0),  # exactly at the threshold is free
        (300_001, 0, 0),
        (1_000_000, 0, 0),
    ],
)
def test_fee_and_remaining_around_the_threshold(subtotal: int, fee: int, remaining: int) -> None:
    zone = rules()
    assert delivery_fee_for(zone, subtotal) == fee
    assert free_delivery_remaining(zone, subtotal) == remaining


def test_without_a_threshold_delivery_is_never_free() -> None:
    zone = rules(free_delivery_threshold_uzs=None, delivery_fee_uzs=30_000)
    for subtotal in (0, 300_000, 10_000_000):
        assert delivery_fee_for(zone, subtotal) == 30_000
        assert free_delivery_remaining(zone, subtotal) is None


def test_zero_threshold_is_always_free() -> None:
    zone = rules(free_delivery_threshold_uzs=0)
    assert delivery_fee_for(zone, 0) == 0
    assert free_delivery_remaining(zone, 0) == 0


# --- working hours --------------------------------------------------------------------------------


def _local(hour: int, minute: int = 0, second: int = 0, micro: int = 0) -> datetime:
    return datetime(2026, 10, 31, hour, minute, second, micro, tzinfo=TASHKENT_TZ)


@pytest.mark.parametrize(
    ("moment", "is_open"),
    [
        (_local(8, 59, 59, 999_999), False),
        (_local(9, 0), True),  # opening is inclusive
        (_local(15, 30), True),
        (_local(20, 59, 59, 999_999), True),
        (_local(21, 0), False),  # closing is exclusive
        (_local(23, 0), False),
        (_local(0, 0), False),
    ],
)
def test_opening_hours_boundaries(moment: datetime, is_open: bool) -> None:
    assert is_open_at(rules(), moment) is is_open


def test_utc_instants_are_converted_to_tashkent_time() -> None:
    zone = rules()
    # 04:00 UTC is 09:00 in Tashkent (UTC+5): open; 03:59 UTC is 08:59: closed.
    assert is_open_at(zone, datetime(2026, 10, 31, 4, 0, tzinfo=UTC))
    assert not is_open_at(zone, datetime(2026, 10, 31, 3, 59, tzinfo=UTC))
    # 16:00 UTC is 21:00 local: closed; 15:59 UTC is 20:59: open.
    assert not is_open_at(zone, datetime(2026, 10, 31, 16, 0, tzinfo=UTC))
    assert is_open_at(zone, datetime(2026, 10, 31, 15, 59, tzinfo=UTC))
    # Any other offset works too: 12:00 in UTC+9 is 08:00 in Tashkent.
    tokyo = timezone(timedelta(hours=9))
    assert not is_open_at(zone, datetime(2026, 10, 31, 12, 0, tzinfo=tokyo))
    # The same instant in summer and winter: Tashkent has no daylight saving.
    assert is_open_at(zone, datetime(2026, 7, 1, 4, 0, tzinfo=UTC))
    assert is_open_at(zone, datetime(2026, 1, 1, 4, 0, tzinfo=UTC))


def test_naive_datetimes_are_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        is_open_at(rules(), datetime(2026, 10, 31, 12, 0))


def test_utc_now_from_timestamp() -> None:
    now = utc_now_from(1_767_225_600.0)
    assert now == datetime(2026, 1, 1, tzinfo=UTC)
    assert now.tzinfo is UTC
    assert TASHKENT_TZ.utcoffset(None) == timedelta(hours=5)


# --- quote ----------------------------------------------------------------------------------------


def line(
    price: int, quantity: int = 1, *, available: bool = True, stock: int | None = None
) -> LineFacts:
    return LineFacts(
        price_uzs=price, quantity=quantity, is_available=available, stock_quantity=stock
    )


def test_quote_adds_the_fee_to_the_subtotal() -> None:
    quote = build_quote([line(20_000, 2), line(15_000)], rules())
    assert (quote.subtotal_uzs, quote.delivery_fee_uzs, quote.total_uzs) == (55_000, 15_000, 70_000)
    assert quote.cart.item_count == 3
    assert quote.free_delivery_remaining_uzs == 245_000
    assert quote.issues == ()
    assert quote.can_place_order


def test_quote_is_free_at_the_threshold() -> None:
    quote = build_quote([line(100_000, 3)], rules())
    assert (quote.subtotal_uzs, quote.delivery_fee_uzs, quote.total_uzs) == (300_000, 0, 300_000)
    assert quote.free_delivery_remaining_uzs == 0


def test_empty_cart() -> None:
    quote = build_quote([], rules())
    assert quote.issues == ("cart_empty",)
    assert not quote.can_place_order
    # The minimum order is not reported on top of an empty cart.
    assert "below_min_order" not in quote.issues
    assert quote.subtotal_uzs == 0


def test_minimum_order_is_compared_with_the_subtotal_before_delivery() -> None:
    zone = rules(min_order_uzs=50_000, delivery_fee_uzs=15_000)
    # 40 000 + 15 000 delivery = 55 000 >= 50 000, but the subtotal is what counts.
    below = build_quote([line(40_000)], zone)
    assert below.total_uzs == 55_000
    assert below.issues == ("below_min_order",)
    assert not below.can_place_order
    exactly = build_quote([line(50_000)], zone)
    assert exactly.issues == ()
    assert exactly.can_place_order


def test_lines_with_issues_are_excluded_and_block_the_order() -> None:
    zone = rules(min_order_uzs=50_000)
    quote = build_quote(
        [
            line(60_000),
            line(500_000, available=False),
            line(10_000, 5, stock=3),
        ],
        zone,
    )
    assert [evaluated.issue for evaluated in quote.lines] == [
        None,
        "product_inactive",
        "insufficient_stock",
    ]
    # Only the valid line counts: no free delivery from the inactive 500 000 line.
    assert quote.subtotal_uzs == 60_000
    assert quote.delivery_fee_uzs == 15_000
    assert quote.total_uzs == 75_000
    assert quote.cart.item_count == 1
    assert quote.issues == ("cart_has_issues",)
    assert not quote.can_place_order


def test_only_invalid_lines_report_both_issues() -> None:
    quote = build_quote([line(100_000, available=False)], rules(min_order_uzs=50_000))
    assert quote.subtotal_uzs == 0
    assert quote.issues == ("cart_has_issues", "below_min_order")


def test_zero_minimum_order() -> None:
    quote = build_quote([line(1_000)], rules(min_order_uzs=0))
    assert quote.issues == ()


# --- phone ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "+998001234567",
        "+998 00 123-45-67",
        "+998 (00) 123 45 67",
        "+998(00)1234567",
        " +998 00 123 45 67 ",
        "+998\t00\t1234567",
    ],
)
def test_phone_numbers_are_normalized(raw: str) -> None:
    assert normalize_uz_phone(raw) == "+998001234567"


@pytest.mark.parametrize(
    "raw",
    [
        "998001234567",  # no plus
        "+7 901 234 56 78",  # another country
        "+79012345678",
        "+99800123456",  # 8 digits
        "+9980012345678",  # 10 digits
        "+998 00 123 45 6a",
        "+998.90.123.45.67",
        "",
        "+",
        "+998001234567 ext 1",
        "+\u0669\u0669\u0668\u0669\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667",  # Arabic-Indic
        "+998\u0669\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667",  # ASCII prefix only
        "+998\uff19\uff10\uff11\uff12\uff13\uff14\uff15\uff16\uff17",  # fullwidth digits
    ],
)
def test_other_phone_numbers_are_rejected(raw: str) -> None:
    with pytest.raises(ValueError, match="Uzbekistan number"):
        normalize_uz_phone(raw)


# --- customer cancellation ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "allowed"),
    [
        (OrderStatus.NEW, True),
        (OrderStatus.CONFIRMED, True),
        (OrderStatus.PICKING, False),
        (OrderStatus.READY_FOR_DELIVERY, False),
        (OrderStatus.OUT_FOR_DELIVERY, False),
        (OrderStatus.DELIVERED, False),
        (OrderStatus.CANCELLED, False),
    ],
)
def test_customer_can_cancel_only_before_picking(status: OrderStatus, allowed: bool) -> None:
    assert customer_can_cancel(status) is allowed


# --- order numbers --------------------------------------------------------------------------------


def test_order_numbers_use_the_tashkent_date() -> None:
    # 20:00 UTC on 31 October is already 1 November in Tashkent.
    number = new_order_number(datetime(2026, 10, 31, 20, 0, tzinfo=UTC))
    assert re.fullmatch(r"261101-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}", number)
    assert new_order_number(datetime(2026, 10, 31, 18, 59, tzinfo=UTC)).startswith("261031-")
    assert len({new_order_number(datetime.now(UTC)) for _ in range(50)}) == 50
