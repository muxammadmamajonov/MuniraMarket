"""Record builders shared by the checkout/order route and schema tests (no database involved)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from app.domain.checkout import build_quote
from app.domain.order_status import OrderStatus
from app.models.enums import PaymentMethod, Unit, UserRole
from app.repositories.cart import CartLineRecord
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
    "lat": 41.311081,
    "lon": 69.240562,
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
        "address": {"lat": 41.311081, "lon": 69.240562, "street": "Demo ko'cha", "house": "12"},
        "recipient_name": "Demo Mijoz",
        "recipient_phone": DEMO_PHONE,
        "payment_method": "cash_on_delivery",
        "expected_total_uzs": 50_000,
    }
    body.update(overrides)
    return body


def make_quote(lines: tuple[CartLineRecord, ...]) -> QuoteRecord:
    return QuoteRecord(lines=lines, totals=build_quote(line_facts(lines)))


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
        "total_uzs": 50_000,
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
