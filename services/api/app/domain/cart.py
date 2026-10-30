"""Cart rules as pure, dependency-free functions: quantity limits, line issues and totals.

Money is integer UZS. The cart never reserves stock; checkout re-validates.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

MAX_LINE_QUANTITY = 99
MAX_CART_LINES = 50

CartIssue = Literal["product_inactive", "insufficient_stock"]


class CartError(Exception):
    """Base class for rule violations raised by the cart repository."""


class ProductNotFoundError(CartError):
    pass


class ProductInactiveError(CartError):
    pass


class InsufficientStockError(CartError):
    def __init__(self, available_quantity: int) -> None:
        super().__init__(f"only {available_quantity} in stock")
        self.available_quantity = available_quantity


class QuantityLimitExceededError(CartError):
    pass


class CartLimitReachedError(CartError):
    pass


class CartItemNotFoundError(CartError):
    pass


def is_in_stock(stock_quantity: int | None) -> bool:
    """``None`` means stock is not tracked, which counts as always in stock."""
    return stock_quantity is None or stock_quantity > 0


def check_line_quantity(*, quantity: int, stock_quantity: int | None) -> None:
    """Validate the *resulting* quantity of one line for an orderable product.

    Stock is checked first because it carries an actionable number (``available_quantity``).
    """
    if stock_quantity is not None and quantity > stock_quantity:
        raise InsufficientStockError(stock_quantity)
    if quantity > MAX_LINE_QUANTITY:
        raise QuantityLimitExceededError


def check_can_add_line(*, existing_lines: int) -> None:
    """A *new* line is refused once the cart already has the maximum number of lines."""
    if existing_lines >= MAX_CART_LINES:
        raise CartLimitReachedError


def line_issue(
    *, is_available: bool, stock_quantity: int | None, quantity: int
) -> CartIssue | None:
    """What (if anything) is wrong with an existing cart line right now."""
    if not is_available:
        return "product_inactive"
    if stock_quantity is not None and quantity > stock_quantity:
        return "insufficient_stock"
    return None


@dataclass(frozen=True, slots=True)
class LineFacts:
    """Facts needed to evaluate one line (``is_available``: product and its categories active)."""

    price_uzs: int
    quantity: int
    is_available: bool
    stock_quantity: int | None


@dataclass(frozen=True, slots=True)
class EvaluatedLine:
    issue: CartIssue | None
    line_total_uzs: int


@dataclass(frozen=True, slots=True)
class CartTotals:
    item_count: int
    subtotal_uzs: int
    total_uzs: int
    has_issues: bool


def evaluate_line(facts: LineFacts) -> EvaluatedLine:
    """``line_total_uzs`` is always price x quantity; lines with an issue are excluded later."""
    return EvaluatedLine(
        issue=line_issue(
            is_available=facts.is_available,
            stock_quantity=facts.stock_quantity,
            quantity=facts.quantity,
        ),
        line_total_uzs=facts.price_uzs * facts.quantity,
    )


def evaluate_cart(lines: Sequence[LineFacts]) -> tuple[list[EvaluatedLine], CartTotals]:
    """Evaluate every line, then total only the valid ones.

    ``total_uzs`` equals the subtotal until delivery fees exist (checkout phase).
    """
    evaluated = [evaluate_line(facts) for facts in lines]
    valid = [
        (facts, result)
        for facts, result in zip(lines, evaluated, strict=True)
        if result.issue is None
    ]
    subtotal = sum(result.line_total_uzs for _, result in valid)
    totals = CartTotals(
        item_count=sum(facts.quantity for facts, _ in valid),
        subtotal_uzs=subtotal,
        total_uzs=subtotal,
        has_issues=len(valid) != len(lines),
    )
    return evaluated, totals
