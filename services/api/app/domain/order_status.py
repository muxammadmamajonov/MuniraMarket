"""Order lifecycle: allowed status transitions as a pure, dependency-free module."""

from enum import StrEnum


class OrderStatus(StrEnum):
    NEW = "NEW"
    CONFIRMED = "CONFIRMED"
    PICKING = "PICKING"
    READY_FOR_DELIVERY = "READY_FOR_DELIVERY"
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY"
    DELIVERED = "DELIVERED"
    CANCELLED = "CANCELLED"


FINAL_STATUSES: frozenset[OrderStatus] = frozenset({OrderStatus.DELIVERED, OrderStatus.CANCELLED})

_FORWARD: dict[OrderStatus, OrderStatus] = {
    OrderStatus.NEW: OrderStatus.CONFIRMED,
    OrderStatus.CONFIRMED: OrderStatus.PICKING,
    OrderStatus.PICKING: OrderStatus.READY_FOR_DELIVERY,
    OrderStatus.READY_FOR_DELIVERY: OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.OUT_FOR_DELIVERY: OrderStatus.DELIVERED,
}

# Every non-final status may be cancelled (with a reason); final statuses have no way out.
ALLOWED_TRANSITIONS: dict[OrderStatus, frozenset[OrderStatus]] = {
    status: (
        frozenset()
        if status in FINAL_STATUSES
        else frozenset({_FORWARD[status], OrderStatus.CANCELLED})
    )
    for status in OrderStatus
}


class InvalidOrderTransitionError(ValueError):
    """Raised when a status change is not permitted."""


def can_transition(
    current: OrderStatus,
    target: OrderStatus,
    *,
    cancel_reason: str | None = None,
) -> bool:
    """Return whether ``current -> target`` is allowed.

    Cancelling requires a non-blank ``cancel_reason``.
    """
    if target not in ALLOWED_TRANSITIONS[current]:
        return False
    if target is OrderStatus.CANCELLED:
        return bool(cancel_reason and cancel_reason.strip())
    return True


def ensure_transition(
    current: OrderStatus,
    target: OrderStatus,
    *,
    cancel_reason: str | None = None,
) -> None:
    if not can_transition(current, target, cancel_reason=cancel_reason):
        raise InvalidOrderTransitionError(f"Cannot move order from {current} to {target}")
