"""Checkout request validation, the idempotency request hash and order response shaping."""

import hashlib
import uuid
from datetime import date, time
from typing import Any

import pytest
from pydantic import ValidationError

from app.api.routes.orders import request_hash
from app.domain.order_status import OrderStatus
from app.repositories.orders import SlotSnapshotRecord
from app.schemas.checkout import (
    AdminOrderDetail,
    CancelOrderRequest,
    CheckoutQuoteRequest,
    CreateOrderRequest,
    OrderDetail,
    OrderStatusUpdateRequest,
)
from tests.order_factories import DEMO_PHONE, make_order, order_body


def parse(**overrides: Any) -> CreateOrderRequest:
    return CreateOrderRequest.model_validate(order_body(**overrides))


def with_address(**fields: Any) -> dict[str, Any]:
    return {"district": "chilonzor", "street": "Demo ko'cha", "house": "12", **fields}


# --- create order ---------------------------------------------------------------------------------


def test_minimal_body() -> None:
    request = parse()
    assert request.address.district == "chilonzor"
    assert request.address.apartment is None
    assert request.comment is None
    assert request.recipient_phone == DEMO_PHONE


def test_fields_are_trimmed_and_the_phone_normalized() -> None:
    request = parse(
        address=with_address(street="  Demo ko'cha  ", house=" 12a ", apartment=" 5 "),
        recipient_name="  Demo Mijoz ",
        recipient_phone=" +998 (00) 123-45-67 ",
        comment="  Eshik oldida qo'ng'iroq qiling  ",
    )
    assert request.address.street == "Demo ko'cha"
    assert request.address.house == "12a"
    assert request.address.apartment == "5"
    assert request.recipient_name == "Demo Mijoz"
    assert request.recipient_phone == DEMO_PHONE
    assert request.comment == "Eshik oldida qo'ng'iroq qiling"


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n"])
def test_blank_optional_fields_become_null(blank: str) -> None:
    request = parse(
        address=with_address(apartment=blank, entrance=blank, floor=blank, landmark=blank),
        comment=blank,
    )
    address = request.address
    assert (address.apartment, address.entrance, address.floor, address.landmark) == (None,) * 4
    assert request.comment is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"address": with_address(street="Demo\nko'cha")},
        {"address": with_address(street="Demo\rko'cha")},
        {"address": with_address(street="Demo\tko'cha")},
        {"address": with_address(house="1\x002")},
        {"address": with_address(landmark="Demo\nbozor")},
        {"address": with_address(apartment="5\x1b")},
        {"recipient_name": "Demo\nMijoz"},
        {"recipient_name": "Demo\x7fMijoz"},
        {"comment": "Demo\x00izoh"},
        {"comment": "Demo\x1bizoh"},
    ],
)
def test_control_characters_are_rejected(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        parse(**overrides)


def test_the_comment_may_span_lines() -> None:
    assert parse(comment="Birinchi qator\nIkkinchi qator").comment == (
        "Birinchi qator\nIkkinchi qator"
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"subtotal_uzs": 1},
        {"total_uzs": 1},
        {"address": with_address(latitude=41.3)},
        {"address": with_address(district="tashkent")},
        {"address": with_address(district="Chilonzor")},
        {"address": with_address(district="")},
        {"address": with_address(street="D")},  # too short
        {"address": with_address(street="D" * 201)},
        {"address": with_address(house="")},
        {"address": with_address(apartment="1" * 17)},
        {"recipient_name": "D"},
        {"recipient_name": "D" * 101},
        {"recipient_phone": "998001234567"},
        {"recipient_phone": "+7 901 234 56 78"},
        {"recipient_phone": "+99800123456"},
        {"recipient_phone": "+9980012345678"},
        {"recipient_phone": "+998 00 123 45 67" + " " * 20},  # over 32 characters
        {"payment_method": "crypto"},
        {"expected_total_uzs": -1},
        {"expected_total_uzs": 65_000.5},
        {"comment": "D" * 501},
    ],
)
def test_invalid_bodies(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        parse(**overrides)


@pytest.mark.parametrize(
    "missing",
    ["address", "recipient_name", "recipient_phone", "payment_method", "expected_total_uzs"],
)
def test_required_fields(missing: str) -> None:
    body = order_body()
    del body[missing]
    with pytest.raises(ValidationError):
        CreateOrderRequest.model_validate(body)


def test_the_address_snapshot_has_every_field() -> None:
    dumped = parse(address=with_address(floor=" 3 ")).address.model_dump(mode="json")
    assert dumped == {
        "district": "chilonzor",
        "street": "Demo ko'cha",
        "house": "12",
        "apartment": None,
        "entrance": None,
        "floor": "3",
        "landmark": None,
    }


# --- request hash ---------------------------------------------------------------------------------


def test_request_hash_ignores_cosmetic_differences() -> None:
    plain = parse()
    cosmetic = CreateOrderRequest.model_validate(
        {
            # different key order, spacing, explicit nulls / blanks for optional fields
            "expected_total_uzs": 65_000,
            "payment_method": "cash_on_delivery",
            "recipient_phone": "+998 (00) 123-45-67",
            "recipient_name": " Demo Mijoz ",
            "comment": "   ",
            "address": {
                "house": " 12 ",
                "street": "Demo ko'cha ",
                "district": "chilonzor",
                "apartment": "",
                "landmark": None,
            },
        }
    )
    assert request_hash(plain) == request_hash(cosmetic)
    assert len(request_hash(plain)) == 64


@pytest.mark.parametrize(
    "overrides",
    [
        {"address": with_address(house="13")},
        {"address": with_address(district="olmazor")},
        {"recipient_phone": "+998001234568"},
        {"payment_method": "card_on_delivery"},
        {"expected_total_uzs": 65_001},
        {"comment": "Demo izoh"},
    ],
)
def test_request_hash_changes_with_the_order(overrides: dict[str, Any]) -> None:
    assert request_hash(parse()) != request_hash(parse(**overrides))


# --- other requests -------------------------------------------------------------------------------


def test_quote_request_needs_a_known_district() -> None:
    assert CheckoutQuoteRequest.model_validate({"district": "sergeli"}).district == "sergeli"
    for body in ({"district": "nowhere"}, {}, {"district": "sergeli", "x": 1}):
        with pytest.raises(ValidationError):
            CheckoutQuoteRequest.model_validate(body)


def test_cancel_reason() -> None:
    assert CancelOrderRequest.model_validate({"reason": "  Fikrim o'zgardi "}).reason == (
        "Fikrim o'zgardi"
    )
    for body in (
        {"reason": "  "},
        {"reason": "ab"},
        {"reason": "x" * 301},
        {},
        {"reason": "a\x00bc"},
        {"reason": "abc", "extra": True},
    ):
        with pytest.raises(ValidationError):
            CancelOrderRequest.model_validate(body)


def test_status_update_request() -> None:
    request = OrderStatusUpdateRequest.model_validate({"status": "CONFIRMED"})
    assert request.status is OrderStatus.CONFIRMED
    assert request.reason is None
    assert request.expected_status is None
    for body in (
        {"status": "SHIPPED"},
        {"status": "CANCELLED", "reason": " "},
        {"status": "CONFIRMED", "expected_status": "nope"},
        {"status": "CONFIRMED", "note": "x"},
    ):
        with pytest.raises(ValidationError):
            OrderStatusUpdateRequest.model_validate(body)


# --- responses ------------------------------------------------------------------------------------


def test_order_detail_shape() -> None:
    detail = OrderDetail.from_record(make_order())
    assert detail.address.district_name_uz == "Chilonzor"
    assert detail.address.district_name_ru == "Чиланзарский"
    assert detail.can_cancel
    assert [change.status for change in detail.history] == [OrderStatus.NEW]
    assert not OrderDetail.from_record(make_order(OrderStatus.PICKING)).can_cancel
    # The customer view has no audit details (actor roles, reasons).
    assert "history_detail" not in OrderDetail.model_fields


@pytest.mark.parametrize(
    ("status", "allowed"),
    [
        (OrderStatus.NEW, [OrderStatus.CONFIRMED, OrderStatus.CANCELLED]),
        (OrderStatus.CONFIRMED, [OrderStatus.PICKING, OrderStatus.CANCELLED]),
        (OrderStatus.PICKING, [OrderStatus.READY_FOR_DELIVERY, OrderStatus.CANCELLED]),
        (
            OrderStatus.READY_FOR_DELIVERY,
            [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED],
        ),
        (OrderStatus.OUT_FOR_DELIVERY, [OrderStatus.DELIVERED, OrderStatus.CANCELLED]),
        (OrderStatus.DELIVERED, []),
        (OrderStatus.CANCELLED, []),
    ],
)
def test_admin_detail_lists_allowed_transitions(
    status: OrderStatus, allowed: list[OrderStatus]
) -> None:
    detail = AdminOrderDetail.from_admin_record(make_order(status))
    assert detail.allowed_transitions == allowed
    assert detail.status is status


def test_admin_detail_includes_the_audit_trail() -> None:
    detail = AdminOrderDetail.from_admin_record(make_order(OrderStatus.CANCELLED))
    assert [
        (c.from_status, c.status, c.actor_role.value, c.reason) for c in detail.history_detail
    ] == [
        (None, OrderStatus.NEW, "customer", None),
        (OrderStatus.NEW, OrderStatus.CANCELLED, "operator", "Demo sabab"),
    ]
    assert detail.cancel_reason == "Demo sabab"
    assert not detail.can_cancel


# --- delivery slots -------------------------------------------------------------------------------


def test_the_slot_id_is_optional_and_must_be_a_uuid() -> None:
    assert parse().delivery_slot_id is None
    slot_id = uuid.uuid4()
    assert parse(delivery_slot_id=str(slot_id)).delivery_slot_id == slot_id
    for bad in ("", "slot-1", 7):
        with pytest.raises(ValidationError):
            parse(delivery_slot_id=bad)


def test_request_hash_without_a_slot_is_unchanged() -> None:
    """Bodies that never had a slot hash exactly as before the field existed, so a retry that
    spans a deploy still replays instead of conflicting."""
    request = parse()
    legacy = request.model_dump_json(exclude={"delivery_slot_id"})
    assert request_hash(request) == hashlib.sha256(legacy.encode()).hexdigest()
    assert request_hash(parse(delivery_slot_id=str(uuid.uuid4()))) != request_hash(request)
    first, second = uuid.uuid4(), uuid.uuid4()
    assert request_hash(parse(delivery_slot_id=str(first))) != request_hash(
        parse(delivery_slot_id=str(second))
    )


def test_order_detail_delivery_slot() -> None:
    assert OrderDetail.from_record(make_order()).delivery_slot is None
    record = make_order(
        delivery_slot=SlotSnapshotRecord(
            slot_date=date(2026, 11, 1), starts_at=time(10, 0), ends_at=time(13, 0)
        )
    )
    detail = OrderDetail.from_record(record)
    assert detail.model_dump(mode="json")["delivery_slot"] == {
        "date": "2026-11-01",
        "starts_at": "10:00",
        "ends_at": "13:00",
    }
    admin = AdminOrderDetail.from_admin_record(record)
    assert admin.delivery_slot == detail.delivery_slot
