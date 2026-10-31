"""Checkout rules as pure functions: the quote (subtotal, delivery fee, total) and order errors.

The quote and order creation evaluate the cart with exactly the same function, so what the
customer is shown is what the order is created with (or the order is refused). Money is integer
UZS; clients never send prices, only the total they were shown (``expected_total_uzs``) so a price
change between quote and order is detected instead of silently charged.
"""

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from app.domain.cart import CartTotals, EvaluatedLine, LineFacts, evaluate_cart
from app.domain.delivery import ZoneRules, delivery_fee_for, free_delivery_remaining

QuoteIssue = Literal["cart_empty", "cart_has_issues", "below_min_order"]

# Unconfirmed (``NEW``) orders one customer may have at once. Cash/card on delivery means an order
# costs nothing to place, so this bounds how much tracked stock one account can hold.
MAX_OPEN_ORDERS = 5


@dataclass(frozen=True, slots=True)
class QuoteTotals:
    lines: list[EvaluatedLine]
    cart: CartTotals
    subtotal_uzs: int
    delivery_fee_uzs: int
    total_uzs: int
    free_delivery_remaining_uzs: int | None
    issues: tuple[QuoteIssue, ...]

    @property
    def can_place_order(self) -> bool:
        return not self.issues


def build_quote(lines: Sequence[LineFacts], rules: ZoneRules) -> QuoteTotals:
    """Evaluate the cart against a zone.

    Lines with an issue are excluded from the subtotal (as in the cart) and block the order. The
    minimum order is compared with the subtotal of valid lines, before delivery.
    """
    evaluated, cart = evaluate_cart(lines)
    subtotal = cart.subtotal_uzs
    fee = delivery_fee_for(rules, subtotal)
    issues: list[QuoteIssue] = []
    if not lines:
        issues.append("cart_empty")
    if cart.has_issues:
        issues.append("cart_has_issues")
    if lines and subtotal < rules.min_order_uzs:
        issues.append("below_min_order")
    return QuoteTotals(
        lines=evaluated,
        cart=cart,
        subtotal_uzs=subtotal,
        delivery_fee_uzs=fee,
        total_uzs=subtotal + fee,
        free_delivery_remaining_uzs=free_delivery_remaining(rules, subtotal),
        issues=tuple(issues),
    )


# --- phone ----------------------------------------------------------------------------------------

# ASCII digits only: ``\d`` would also accept e.g. Arabic-Indic or fullwidth digits.
UZ_PHONE_RE = re.compile(r"\+998[0-9]{9}")
_PHONE_SEPARATORS = re.compile(r"[\s\-()]")


def normalize_uz_phone(raw: str) -> str:
    """``+998 00 123-45-67`` -> ``+998001234567``. Raises ``ValueError`` for anything else."""
    compact = _PHONE_SEPARATORS.sub("", raw)
    if not UZ_PHONE_RE.fullmatch(compact):
        raise ValueError("phone must be an Uzbekistan number: +998 followed by 9 digits")
    return compact


# --- errors raised by the order repository ----------------------------------------------------


class CheckoutError(Exception):
    """Base class for checkout/order rule violations."""


class DistrictNotServedError(CheckoutError):
    pass


class CartEmptyError(CheckoutError):
    pass


class OrderProductUnavailableError(CheckoutError):
    def __init__(self, product_id: uuid.UUID) -> None:
        super().__init__("product is not available")
        self.product_id = product_id


class OrderInsufficientStockError(CheckoutError):
    def __init__(self, product_id: uuid.UUID, available_quantity: int) -> None:
        super().__init__(f"only {available_quantity} in stock")
        self.product_id = product_id
        self.available_quantity = available_quantity


class BelowMinimumOrderError(CheckoutError):
    pass


class TooManyOpenOrdersError(CheckoutError):
    """The customer already has ``MAX_OPEN_ORDERS`` orders waiting for confirmation."""


class PriceChangedError(CheckoutError):
    def __init__(self, total_uzs: int) -> None:
        super().__init__("order total changed since the quote")
        self.total_uzs = total_uzs


class IdempotencyKeyConflictError(CheckoutError):
    """The key was already used by this user for a different order request."""


class OrderNotFoundError(CheckoutError):
    """Unknown order, or not the caller's (both look the same: no IDOR oracle)."""


class OrderNotCancellableError(CheckoutError):
    def __init__(self, current_status: str) -> None:
        super().__init__(f"order cannot be cancelled in status {current_status}")
        self.current_status = current_status


class OrderStatusConflictError(CheckoutError):
    """Optimistic concurrency: the order is no longer in the status the operator saw."""

    def __init__(self, current_status: str) -> None:
        super().__init__(f"order is now {current_status}")
        self.current_status = current_status


class InvalidStatusTransitionError(CheckoutError):
    def __init__(self, current_status: str) -> None:
        super().__init__(f"transition not allowed from {current_status}")
        self.current_status = current_status
