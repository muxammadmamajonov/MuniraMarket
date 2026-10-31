"""Record builders shared by the checkout/order route and schema tests (no database involved)."""

import uuid
from datetime import UTC, datetime, time
from typing import Any

from app.domain.checkout import build_quote
from app.domain.delivery import ZoneRules
from app.domain.order_status import OrderStatus
from app.models.enums import PaymentMethod, Unit, UserRole
from app.repositories.cart import CartLineRecord
from app.repositories.delivery import ZoneRecord
from app.repositories.orders import (
    OrderItemRecord,
    OrderRecord,
    QuoteRecord,
    StatusChangeRecord,
    line_facts,
)

CREATED_AT = datetime(2026, 10, 31, 7, 0, tzinfo=UTC)

# Obviously fake recipient data.
DEMO_PHONE = "+998001234567"
DEMO_ADDRESS: dict[str, Any] = {
    "district": "chilonzor",
    "street": "Demo ko'cha",
    "house": "12",
    "apartment": None,
    "entrance": None,
    "floor": None,
    "landmark": None,
}


def order_body(**overrides: Any) -> dict[str, Any]:
    """A valid ``POST /orders`` body."""
    body: dict[str, Any] = {
        "address": {"district": "chilonzor", "street": "Demo ko'cha", "house": "12"},
        "recipient_name": "Demo Mijoz",
        "recipient_phone": DEMO_PHONE,
        "payment_method": "cash_on_delivery",
        "expected_total_uzs": 65_000,
    }
    body.update(overrides)
    return body


def make_zone(**overrides: Any) -> ZoneRecord:
    rules: dict[str, Any] = {
        "delivery_fee_uzs": 15_000,
        "free_delivery_threshold_uzs": 300_000,
        "min_order_uzs": 50_000,
        "opens_at": time(9, 0),
        "closes_at": time(21, 0),
    }
    for key in list(overrides):
        if key in rules:
            rules[key] = overrides.pop(key)
    values: dict[str, Any] = {
        "zone_id": uuid.uuid4(),
        "is_active": True,
        "districts": frozenset({"chilonzor", "olmazor"}),
        "slug": "demo-zone",
        "name_uz": "Demo zona",
        "name_ru": "Демо зона",
        "rules": ZoneRules(**rules),
        "sort_order": 10,
    }
    values.update(overrides)
    return ZoneRecord(**values)


def make_quote(lines: tuple[CartLineRecord, ...], zone: ZoneRecord | None = None) -> QuoteRecord:
    zone = zone or make_zone()
    return QuoteRecord(zone=zone, lines=lines, totals=build_quote(line_facts(lines), zone.rules))


def make_order(status: OrderStatus = OrderStatus.NEW, **overrides: Any) -> OrderRecord:
    history = [
        StatusChangeRecord(
            from_status=None,
            to_status=OrderStatus.NEW,
            actor_role=UserRole.CUSTOMER,
            reason=None,
            created_at=CREATED_AT,
        )
    ]
    if status is not OrderStatus.NEW:
        history.append(
            StatusChangeRecord(
                from_status=OrderStatus.NEW,
                to_status=status,
                actor_role=UserRole.OPERATOR,
                reason="Demo sabab" if status is OrderStatus.CANCELLED else None,
                created_at=CREATED_AT,
            )
        )
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "number": "261031-ABCDEF",
        "user_id": uuid.uuid4(),
        "status": status,
        "subtotal_uzs": 50_000,
        "delivery_fee_uzs": 15_000,
        "total_uzs": 65_000,
        "item_count": 2,
        "payment_method": PaymentMethod.CASH_ON_DELIVERY,
        "recipient_name": "Demo Mijoz",
        "recipient_phone": DEMO_PHONE,
        "address": dict(DEMO_ADDRESS),
        "comment": None,
        "cancel_reason": "Demo sabab" if status is OrderStatus.CANCELLED else None,
        "created_at": CREATED_AT,
        "updated_at": CREATED_AT,
        "items": (
            OrderItemRecord(
                product_id=uuid.uuid4(),
                sku="DEMO-0001",
                name_uz="Demo mahsulot",
                name_ru="Демо товар",
                unit=Unit.PIECE,
                unit_price_uzs=25_000,
                quantity=2,
                line_total_uzs=50_000,
            ),
        ),
        "history": tuple(history),
    }
    values.update(overrides)
    return OrderRecord(**values)
