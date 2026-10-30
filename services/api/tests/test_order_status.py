import itertools

import pytest

from app.domain.order_status import (
    ALLOWED_TRANSITIONS,
    FINAL_STATUSES,
    InvalidOrderTransitionError,
    OrderStatus,
    can_transition,
    ensure_transition,
)

HAPPY_PATH = [
    OrderStatus.NEW,
    OrderStatus.CONFIRMED,
    OrderStatus.PICKING,
    OrderStatus.READY_FOR_DELIVERY,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.DELIVERED,
]


@pytest.mark.parametrize(("current", "target"), list(itertools.pairwise(HAPPY_PATH)))
def test_forward_steps_are_allowed(current: OrderStatus, target: OrderStatus) -> None:
    assert can_transition(current, target)


@pytest.mark.parametrize(
    "current", [status for status in OrderStatus if status not in FINAL_STATUSES]
)
def test_every_non_final_status_can_be_cancelled_with_reason(current: OrderStatus) -> None:
    assert can_transition(current, OrderStatus.CANCELLED, cancel_reason="Customer called")


@pytest.mark.parametrize("reason", [None, "", "   ", "\n\t"])
def test_cancellation_requires_a_reason(reason: str | None) -> None:
    assert not can_transition(OrderStatus.NEW, OrderStatus.CANCELLED, cancel_reason=reason)
    assert not can_transition(OrderStatus.NEW, OrderStatus.CANCELLED)


@pytest.mark.parametrize("final", sorted(FINAL_STATUSES))
def test_final_statuses_have_no_exits(final: OrderStatus) -> None:
    assert ALLOWED_TRANSITIONS[final] == frozenset()
    for target in OrderStatus:
        assert not can_transition(final, target, cancel_reason="because")


def test_skipping_and_going_backwards_is_rejected() -> None:
    assert not can_transition(OrderStatus.NEW, OrderStatus.PICKING)
    assert not can_transition(OrderStatus.NEW, OrderStatus.DELIVERED)
    assert not can_transition(OrderStatus.PICKING, OrderStatus.CONFIRMED)
    assert not can_transition(OrderStatus.CONFIRMED, OrderStatus.CONFIRMED)


def test_every_status_is_mapped() -> None:
    assert set(ALLOWED_TRANSITIONS) == set(OrderStatus)


def test_ensure_transition_raises_on_invalid() -> None:
    ensure_transition(OrderStatus.NEW, OrderStatus.CONFIRMED)
    with pytest.raises(InvalidOrderTransitionError):
        ensure_transition(OrderStatus.DELIVERED, OrderStatus.NEW)
    with pytest.raises(InvalidOrderTransitionError):
        ensure_transition(OrderStatus.NEW, OrderStatus.CANCELLED)
