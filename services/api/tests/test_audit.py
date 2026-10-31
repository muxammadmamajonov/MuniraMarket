"""``app/audit.py`` (what may reach the append-only audit log) and image URL validation."""

import uuid
from datetime import UTC, date, datetime, time
from enum import Enum

import pytest

from app.audit import MAX_TEXT_LENGTH, diff_fields, safe_details
from app.domain.image_url import InvalidImageUrlError, validate_image_url
from app.models.enums import UserRole


class _Color(Enum):
    RED = "red"


def test_changes_keep_only_allow_listed_fields() -> None:
    details = safe_details(
        "product",
        {
            "price_uzs": (10_000, 12_000),
            "stock_quantity": (None, 5),
            "is_active": (True, False),
            "description_uz": ("old", "new"),
            "brand": ("a", "b"),
        },
    )
    assert details == {
        "changes": {
            "price_uzs": {"from": 10_000, "to": 12_000},
            "stock_quantity": {"from": None, "to": 5},
            "is_active": {"from": True, "to": False},
        }
    }


@pytest.mark.parametrize(
    "field",
    [
        "phone",
        "recipient_phone",
        "address",
        "first_name",
        "last_name",
        "username",
        "telegram_user_id",
        "init_data",
        "csrf_token",
        "session_cookie",
        "comment",
        "cancel_reason",
        "password",
    ],
)
@pytest.mark.parametrize("entity_type", ["user", "order", "product", "unknown"])
def test_personal_fields_never_pass(field: str, entity_type: str) -> None:
    details = safe_details(
        entity_type,
        {field: ("+998901234567", "Demo Person")},
        extra={field: "secret-value"},
    )
    assert details == {}


def test_user_changes_are_role_and_block_only() -> None:
    details = safe_details(
        "user",
        {"role": (UserRole.CUSTOMER, UserRole.ADMIN), "is_blocked": (False, True)},
        extra={"username": "demo_user"},
    )
    assert details == {
        "changes": {
            "role": {"from": "customer", "to": "admin"},
            "is_blocked": {"from": False, "to": True},
        }
    }


def test_extra_keys_are_allow_listed() -> None:
    details = safe_details(
        "catalog",
        extra={"source": "csv", "rows": 3, "creates": 1, "file_name": "x.csv", "note": "y"},
    )
    assert details == {"source": "csv", "rows": 3, "creates": 1}


def test_values_become_short_scalars() -> None:
    product_id = uuid.uuid4()
    details = safe_details(
        "product",
        {
            "category_id": (None, product_id),
            "name_uz": ("a", "x" * 500),
            "unit": (None, _Color.RED),
            "slug": (None, {"nested": "dict"}),
        },
    )
    changes = details["changes"]
    assert changes["category_id"] == {"from": None, "to": str(product_id)}
    assert len(changes["name_uz"]["to"]) == MAX_TEXT_LENGTH
    assert changes["unit"]["to"] == "red"
    assert changes["slug"]["to"] is None


def test_dates_lists_and_times() -> None:
    details = safe_details(
        "slot",
        {
            "slot_date": (None, date(2026, 11, 1)),
            "starts_at": (None, time(9, 0)),
            "cutoff_at": (None, datetime(2026, 11, 1, 6, 0, tzinfo=UTC)),
        },
    )
    assert details["changes"]["slot_date"]["to"] == "2026-11-01"
    assert details["changes"]["starts_at"]["to"] == "09:00:00"
    assert details["changes"]["cutoff_at"]["to"].startswith("2026-11-01T06:00")
    zones = safe_details("zone", {"districts": (["b", "a"], ("c",))})
    assert zones["changes"]["districts"] == {"from": "a,b", "to": "c"}


def test_diff_fields() -> None:
    assert diff_fields({"a": 1, "b": 2}, {"a": 1, "b": 3, "c": None}) == {"b": (2, 3)}


# --- image URLs ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.example.com/images/olma.webp",
        "https://cdn.example.com:443/a.png?v=2#x",
        "https://img.example.uz/%D0%B0.png",
    ],
)
def test_valid_image_urls(url: str) -> None:
    assert validate_image_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "http://cdn.example.com/a.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "//cdn.example.com/a.png",
        "https://user:secret@cdn.example.com/a.png",
        "https://@cdn.example.com/a.png",
        "https://cdn.example.com:8443/a.png",
        "https://127.0.0.1/a.png",
        "https://[::1]/a.png",
        "https://10.0.0.5/a.png",
        "https://localhost/a.png",
        "https://printer.local/a.png",
        "https://api.internal/a.png",
        "https://intranet/a.png",
        "https://cdn.example.com/a b.png",
        "https://cdn.example.com/a\tb.png",
        "https://cdn.example.com/" + chr(0x430) + ".png",
        "https://-bad-.example.com/a.png",
        "https://cdn.example.123/a.png",
        "https://" + "a" * 2048 + ".com/",
        "https:///a.png",
    ],
)
def test_invalid_image_urls(url: str) -> None:
    with pytest.raises(InvalidImageUrlError):
        validate_image_url(url)
