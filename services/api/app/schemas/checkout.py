"""Checkout and order request/response models.

The server computes every amount. A client sends the delivery address (a map point plus street
and house), never prices; it sends back only the total it was shown (``expected_total_uzs``) so a
change is refused, not silently charged. There is no delivery charge: a Yandex Go courier carries
the order on demand and the customer pays the courier. Free-text fields are trimmed, blank optional
fields become ``null`` and control characters are rejected.
"""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from app.domain.cart import CartIssue
from app.domain.checkout import QuoteIssue, normalize_uz_phone
from app.domain.geo import COORDINATE_DECIMALS, snapshot_point
from app.domain.order_status import ALLOWED_TRANSITIONS, OrderStatus, customer_can_cancel
from app.models.enums import PaymentMethod, Unit, UserRole
from app.repositories.orders import (
    OrderPageRecord,
    OrderRecord,
    OrderSummaryRecord,
    QuoteRecord,
)
from app.schemas.cart import CartLine
from app.schemas.catalog import ProductSummary

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_CONTROL_OR_NEWLINE = re.compile(r"[\x00-\x1f\x7f]")


def _single_line(value: str) -> str:
    if _CONTROL_OR_NEWLINE.search(value):
        raise ValueError("must be a single line of text")
    return value


def _multi_line(value: str) -> str:
    if _CONTROL.search(value):
        raise ValueError("contains control characters")
    return value


def _phone(value: str) -> str:
    return normalize_uz_phone(value)


def _blank_to_none(value: str | None) -> str | None:
    return value or None


def _six_decimals(value: float) -> float:
    return round(value, COORDINATE_DECIMALS)


def _text(min_length: int, max_length: int) -> StringConstraints:
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)


# WGS84 degrees; ``allow_inf_nan=False`` refuses NaN and +/-Infinity.
Latitude = Annotated[
    float,
    Field(ge=-90, le=90, allow_inf_nan=False, description="WGS84 latitude, -90..90"),
    AfterValidator(_six_decimals),
]
Longitude = Annotated[
    float,
    Field(ge=-180, le=180, allow_inf_nan=False, description="WGS84 longitude, -180..180"),
    AfterValidator(_six_decimals),
]
Street = Annotated[str, _text(2, 200), AfterValidator(_single_line)]
House = Annotated[str, _text(1, 32), AfterValidator(_single_line)]
RecipientName = Annotated[str, _text(2, 100), AfterValidator(_single_line)]
ShortPart = Annotated[
    Annotated[str, _text(0, 16), AfterValidator(_single_line)] | None,
    AfterValidator(_blank_to_none),
]
Floor = Annotated[
    Annotated[str, _text(0, 8), AfterValidator(_single_line)] | None,
    AfterValidator(_blank_to_none),
]
Landmark = Annotated[
    Annotated[str, _text(0, 200), AfterValidator(_single_line)] | None,
    AfterValidator(_blank_to_none),
]
Comment = Annotated[
    Annotated[str, _text(0, 500), AfterValidator(_multi_line)] | None,
    AfterValidator(_blank_to_none),
]
Reason = Annotated[str, _text(3, 300), AfterValidator(_multi_line)]
Phone = Annotated[
    str,
    StringConstraints(max_length=32),
    AfterValidator(_phone),
    Field(description="Uzbekistan number: +998 and 9 digits; spaces, dashes and () are ignored"),
]


# --- requests -------------------------------------------------------------------------------------


class DeliveryAddress(BaseModel):
    """Where the Yandex Go courier takes the order: the map point plus what the courier needs to
    find the door."""

    model_config = ConfigDict(extra="forbid")

    lat: Latitude
    lon: Longitude
    street: Street
    house: House
    apartment: ShortPart = None
    entrance: ShortPart = None
    floor: Floor = None
    landmark: Landmark = None


class CreateOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: DeliveryAddress
    recipient_name: RecipientName
    recipient_phone: Phone
    payment_method: PaymentMethod
    comment: Comment = None
    # The ``total_uzs`` of the quote the customer confirmed.
    expected_total_uzs: int = Field(ge=0)


class CancelOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Reason


class OrderStatusUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: OrderStatus
    # Required (non-blank) when cancelling.
    reason: Reason | None = None
    # Optimistic concurrency: refuse with 409 if the order is no longer in this status.
    expected_status: OrderStatus | None = None


# --- responses ------------------------------------------------------------------------------------


class CheckoutQuote(BaseModel):
    items: list[CartLine]
    item_count: int
    subtotal_uzs: int
    # Always equal to ``subtotal_uzs``: the courier is paid separately, by the customer.
    total_uzs: int
    issues: list[QuoteIssue]
    can_place_order: bool

    @classmethod
    def from_record(cls, record: QuoteRecord) -> Self:
        totals = record.totals
        return cls(
            items=[
                CartLine(
                    product=ProductSummary.from_record(line.product),
                    quantity=line.quantity,
                    line_total_uzs=evaluated.line_total_uzs,
                    issue=evaluated.issue,
                )
                for line, evaluated in zip(record.lines, totals.lines, strict=True)
            ],
            item_count=totals.cart.item_count,
            subtotal_uzs=totals.subtotal_uzs,
            total_uzs=totals.total_uzs,
            issues=list(totals.issues),
            can_place_order=totals.can_place_order,
        )


class OrderLine(BaseModel):
    # ``null`` once the product has been deleted from the catalog; the snapshot stays.
    product_id: uuid.UUID | None
    sku: str
    name_uz: str
    name_ru: str
    unit: Unit
    unit_price_uzs: int
    quantity: int
    line_total_uzs: int


class OrderAddress(BaseModel):
    # ``null`` only for orders placed before courier delivery (no map point was taken then).
    lat: float | None
    lon: float | None
    street: str
    house: str
    apartment: str | None
    entrance: str | None
    floor: str | None
    landmark: str | None

    @classmethod
    def from_snapshot(cls, snapshot: dict[str, Any]) -> Self:
        """Read a stored ``address_snapshot``; keys of the old address shape are ignored."""
        point = snapshot_point(snapshot)
        return cls(
            lat=point.lat if point is not None else None,
            lon=point.lon if point is not None else None,
            street=snapshot["street"],
            house=snapshot["house"],
            apartment=snapshot.get("apartment"),
            entrance=snapshot.get("entrance"),
            floor=snapshot.get("floor"),
            landmark=snapshot.get("landmark"),
        )


class OrderStatusChange(BaseModel):
    status: OrderStatus
    at: datetime


class OrderDetail(BaseModel):
    id: uuid.UUID
    number: str
    status: OrderStatus
    created_at: datetime
    updated_at: datetime
    subtotal_uzs: int
    # Equal to ``subtotal_uzs`` for new orders. Orders placed while the store still charged for
    # delivery keep the total charged then (subtotal plus that delivery charge).
    total_uzs: int
    item_count: int
    payment_method: PaymentMethod
    recipient_name: str
    recipient_phone: str
    address: OrderAddress
    comment: str | None
    cancel_reason: str | None
    items: list[OrderLine]
    history: list[OrderStatusChange]
    can_cancel: bool

    @classmethod
    def from_record(cls, record: OrderRecord) -> Self:
        return cls(
            id=record.id,
            number=record.number,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
            subtotal_uzs=record.subtotal_uzs,
            total_uzs=record.total_uzs,
            item_count=record.item_count,
            payment_method=record.payment_method,
            recipient_name=record.recipient_name,
            recipient_phone=record.recipient_phone,
            address=OrderAddress.from_snapshot(record.address),
            comment=record.comment,
            cancel_reason=record.cancel_reason,
            items=[
                OrderLine(
                    product_id=item.product_id,
                    sku=item.sku,
                    name_uz=item.name_uz,
                    name_ru=item.name_ru,
                    unit=item.unit,
                    unit_price_uzs=item.unit_price_uzs,
                    quantity=item.quantity,
                    line_total_uzs=item.line_total_uzs,
                )
                for item in record.items
            ],
            history=[
                OrderStatusChange(status=change.to_status, at=change.created_at)
                for change in record.history
            ],
            can_cancel=customer_can_cancel(record.status),
        )


class OrderSummary(BaseModel):
    id: uuid.UUID
    number: str
    status: OrderStatus
    total_uzs: int
    item_count: int
    created_at: datetime

    @classmethod
    def from_record(cls, record: OrderSummaryRecord) -> Self:
        return cls(
            id=record.id,
            number=record.number,
            status=record.status,
            total_uzs=record.total_uzs,
            item_count=record.item_count,
            created_at=record.created_at,
        )


class OrderPage(BaseModel):
    items: list[OrderSummary]
    page: int
    page_size: int
    total: int
    total_pages: int

    @classmethod
    def from_record(cls, record: OrderPageRecord, *, page: int, page_size: int) -> Self:
        return cls(
            items=[OrderSummary.from_record(item) for item in record.items],
            page=page,
            page_size=page_size,
            total=record.total,
            total_pages=-(-record.total // page_size),
        )


# --- operator / admin -----------------------------------------------------------------------------


class AdminStatusChange(BaseModel):
    from_status: OrderStatus | None
    status: OrderStatus
    actor_role: UserRole
    reason: str | None
    at: datetime


class AdminOrderDetail(OrderDetail):
    history_detail: list[AdminStatusChange]
    # Statuses this order may move to next (CANCELLED needs a reason).
    allowed_transitions: list[OrderStatus]

    @classmethod
    def from_admin_record(cls, record: OrderRecord) -> Self:
        base = OrderDetail.from_record(record).model_dump()
        return cls(
            **base,
            history_detail=[
                AdminStatusChange(
                    from_status=change.from_status,
                    status=change.to_status,
                    actor_role=change.actor_role,
                    reason=change.reason,
                    at=change.created_at,
                )
                for change in record.history
            ],
            allowed_transitions=sorted(
                ALLOWED_TRANSITIONS[record.status], key=list(OrderStatus).index
            ),
        )


__all__ = [
    "AdminOrderDetail",
    "CancelOrderRequest",
    "CartIssue",
    "CheckoutQuote",
    "CreateOrderRequest",
    "DeliveryAddress",
    "OrderAddress",
    "OrderDetail",
    "OrderPage",
    "OrderStatusUpdateRequest",
]
