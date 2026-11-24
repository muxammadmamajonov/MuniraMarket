"""Pure checkout rules: Tashkent time, map points, the quote and phone numbers."""

import re
from datetime import UTC, date, datetime, time, timedelta

import pytest

from app.domain.cart import LineFacts
from app.domain.checkout import build_quote, normalize_uz_phone
from app.domain.geo import GeoPoint, snapshot_point
from app.domain.order_status import OrderStatus, customer_can_cancel
from app.domain.tashkent import TASHKENT_TZ, tashkent_date, tashkent_instant, utc_now_from
from app.repositories.orders import new_order_number

# --- Tashkent time --------------------------------------------------------------------------------


def test_utc_now_from_timestamp() -> None:
    now = utc_now_from(1_767_225_600.0)
    assert now == datetime(2026, 1, 1, tzinfo=UTC)
    assert now.tzinfo is UTC
    assert TASHKENT_TZ.utcoffset(None) == timedelta(hours=5)


def test_tashkent_date_and_instant() -> None:
    # 19:00 UTC on 31 October is already 1 November in Tashkent (UTC+5, no daylight saving).
    assert tashkent_date(datetime(2026, 10, 31, 19, 0, tzinfo=UTC)) == date(2026, 11, 1)
    assert tashkent_date(datetime(2026, 7, 1, 18, 59, tzinfo=UTC)) == date(2026, 7, 1)
    assert tashkent_instant(date(2026, 11, 1), time(0, 0)) == datetime(
        2026, 10, 31, 19, 0, tzinfo=UTC
    )
    with pytest.raises(ValueError, match="timezone-aware"):
        tashkent_date(datetime(2026, 10, 31, 12, 0))


# --- map points -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("snapshot", "point"),
    [
        ({"lat": 41.311081, "lon": 69.240562}, GeoPoint(41.311081, 69.240562)),
        ({"lat": -33.868819, "lon": -151.209295}, GeoPoint(-33.868819, -151.209295)),
        ({"lat": 90, "lon": -180}, GeoPoint(90.0, -180.0)),
        ({"lat": 0, "lon": 0}, GeoPoint(0.0, 0.0)),
    ],
)
def test_snapshot_point_reads_valid_coordinates(
    snapshot: dict[str, object], point: GeoPoint
) -> None:
    assert snapshot_point({**snapshot, "street": "Demo ko'cha", "house": "1"}) == point


@pytest.mark.parametrize(
    "snapshot",
    [
        {"street": "Demo ko'cha", "house": "1"},  # placed before courier delivery
        {"lat": 41.3},
        {"lat": None, "lon": 69.2},
        {"lat": "41.3", "lon": "69.2"},
        {"lat": True, "lon": 69.2},
        {"lat": float("nan"), "lon": 69.2},
        {"lat": 41.3, "lon": float("inf")},
        {"lat": 90.000001, "lon": 69.2},
        {"lat": 41.3, "lon": -180.5},
        [],
        None,
    ],
)
def test_snapshot_point_without_valid_coordinates_is_none(snapshot: object) -> None:
    assert snapshot_point(snapshot) is None


# --- quote ----------------------------------------------------------------------------------------


def line(
    price: int, quantity: int = 1, *, available: bool = True, stock: int | None = None
) -> LineFacts:
    return LineFacts(
        price_uzs=price, quantity=quantity, is_available=available, stock_quantity=stock
    )


def test_quote_total_is_the_subtotal() -> None:
    # The customer pays the Yandex Go courier directly: no delivery charge in the total.
    quote = build_quote([line(20_000, 2), line(15_000)])
    assert (quote.subtotal_uzs, quote.total_uzs) == (55_000, 55_000)
    assert quote.cart.item_count == 3
    assert quote.issues == ()
    assert quote.can_place_order


def test_any_amount_can_be_ordered() -> None:
    # No minimum order.
    quote = build_quote([line(1_000)])
    assert (quote.total_uzs, quote.issues) == (1_000, ())
    assert quote.can_place_order


def test_empty_cart() -> None:
    quote = build_quote([])
    assert quote.issues == ("cart_empty",)
    assert not quote.can_place_order
    assert (quote.subtotal_uzs, quote.total_uzs) == (0, 0)


def test_lines_with_issues_are_excluded_and_block_the_order() -> None:
    quote = build_quote(
        [
            line(60_000),
            line(500_000, available=False),
            line(10_000, 5, stock=3),
        ]
    )
    assert [evaluated.issue for evaluated in quote.lines] == [
        None,
        "product_inactive",
        "insufficient_stock",
    ]
    assert quote.subtotal_uzs == 60_000
    assert quote.total_uzs == 60_000
    assert quote.cart.item_count == 1
    assert quote.issues == ("cart_has_issues",)
    assert not quote.can_place_order


def test_only_invalid_lines() -> None:
    quote = build_quote([line(100_000, available=False)])
    assert quote.subtotal_uzs == 0
    assert quote.issues == ("cart_has_issues",)


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
