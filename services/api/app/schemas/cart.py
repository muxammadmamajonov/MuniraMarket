"""Cart request/response models. The server computes every amount; clients never send prices."""

import uuid
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field

from app.domain.cart import MAX_LINE_QUANTITY, CartIssue, LineFacts, evaluate_cart
from app.repositories.cart import CartRecord
from app.schemas.catalog import ProductSummary

Quantity = Annotated[int, Field(ge=1, le=MAX_LINE_QUANTITY)]


class AddCartItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: uuid.UUID
    quantity: Quantity


class SetCartItemQuantityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: Quantity


class CartLine(BaseModel):
    product: ProductSummary
    quantity: int
    # Always price x quantity; lines with an ``issue`` are left out of the cart totals.
    line_total_uzs: int
    issue: CartIssue | None


class Cart(BaseModel):
    items: list[CartLine]
    # Sum of quantities of valid lines only.
    item_count: int
    subtotal_uzs: int
    total_uzs: int
    has_issues: bool

    @classmethod
    def from_record(cls, record: CartRecord) -> Self:
        facts = [
            LineFacts(
                price_uzs=line.product.price_uzs,
                quantity=line.quantity,
                is_available=line.is_available,
                stock_quantity=line.product.stock_quantity,
            )
            for line in record.lines
        ]
        evaluated, totals = evaluate_cart(facts)
        return cls(
            items=[
                CartLine(
                    product=ProductSummary.from_record(line.product),
                    quantity=line.quantity,
                    line_total_uzs=result.line_total_uzs,
                    issue=result.issue,
                )
                for line, result in zip(record.lines, evaluated, strict=True)
            ],
            item_count=totals.item_count,
            subtotal_uzs=totals.subtotal_uzs,
            total_uzs=totals.total_uzs,
            has_issues=totals.has_issues,
        )
