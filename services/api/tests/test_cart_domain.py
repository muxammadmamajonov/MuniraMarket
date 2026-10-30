import pytest

from app.domain.cart import (
    MAX_CART_LINES,
    MAX_LINE_QUANTITY,
    CartIssue,
    CartLimitReachedError,
    InsufficientStockError,
    LineFacts,
    QuantityLimitExceededError,
    check_can_add_line,
    check_line_quantity,
    evaluate_cart,
    is_in_stock,
    line_issue,
)


def facts(
    *,
    price: int = 10_000,
    quantity: int = 1,
    available: bool = True,
    stock: int | None = None,
) -> LineFacts:
    return LineFacts(
        price_uzs=price, quantity=quantity, is_available=available, stock_quantity=stock
    )


@pytest.mark.parametrize(("stock", "expected"), [(None, True), (1, True), (500, True), (0, False)])
def test_is_in_stock(stock: int | None, expected: bool) -> None:
    assert is_in_stock(stock) is expected


def test_exact_stock_is_allowed_and_one_more_is_not() -> None:
    check_line_quantity(quantity=5, stock_quantity=5)
    with pytest.raises(InsufficientStockError) as excinfo:
        check_line_quantity(quantity=6, stock_quantity=5)
    assert excinfo.value.available_quantity == 5


def test_zero_stock_rejects_any_quantity() -> None:
    with pytest.raises(InsufficientStockError) as excinfo:
        check_line_quantity(quantity=1, stock_quantity=0)
    assert excinfo.value.available_quantity == 0


def test_untracked_stock_has_no_limit_below_the_line_cap() -> None:
    check_line_quantity(quantity=MAX_LINE_QUANTITY, stock_quantity=None)


def test_line_cap_is_99() -> None:
    check_line_quantity(quantity=99, stock_quantity=1000)
    with pytest.raises(QuantityLimitExceededError):
        check_line_quantity(quantity=100, stock_quantity=1000)
    with pytest.raises(QuantityLimitExceededError):
        check_line_quantity(quantity=100, stock_quantity=None)


def test_stock_error_wins_over_line_cap() -> None:
    with pytest.raises(InsufficientStockError):
        check_line_quantity(quantity=120, stock_quantity=10)


def test_cart_line_cap_is_50() -> None:
    check_can_add_line(existing_lines=MAX_CART_LINES - 1)
    with pytest.raises(CartLimitReachedError):
        check_can_add_line(existing_lines=MAX_CART_LINES)


@pytest.mark.parametrize(
    ("available", "stock", "quantity", "expected"),
    [
        (True, None, 99, None),
        (True, 5, 5, None),
        (True, 5, 6, "insufficient_stock"),
        (True, 0, 1, "insufficient_stock"),
        (False, None, 1, "product_inactive"),
        # Inactive wins when both apply.
        (False, 0, 1, "product_inactive"),
    ],
)
def test_line_issue(
    available: bool, stock: int | None, quantity: int, expected: CartIssue | None
) -> None:
    assert line_issue(is_available=available, stock_quantity=stock, quantity=quantity) == expected


def test_empty_cart_totals() -> None:
    evaluated, totals = evaluate_cart([])
    assert evaluated == []
    assert (totals.item_count, totals.subtotal_uzs, totals.total_uzs) == (0, 0, 0)
    assert totals.has_issues is False


def test_totals_sum_valid_lines_only() -> None:
    lines = [
        facts(price=12_000, quantity=3),
        facts(price=5_000, quantity=2, stock=10),
        facts(price=99_000, quantity=1, available=False),
        facts(price=7_000, quantity=4, stock=3),
    ]
    evaluated, totals = evaluate_cart(lines)
    assert [line.issue for line in evaluated] == [
        None,
        None,
        "product_inactive",
        "insufficient_stock",
    ]
    # Issue lines still show what they would cost, but are not part of the totals.
    assert [line.line_total_uzs for line in evaluated] == [36_000, 10_000, 99_000, 28_000]
    assert totals.subtotal_uzs == 46_000
    assert totals.total_uzs == totals.subtotal_uzs
    assert totals.item_count == 5
    assert totals.has_issues is True


def test_all_valid_lines_have_no_issues() -> None:
    _, totals = evaluate_cart([facts(quantity=2), facts(price=500, quantity=10, stock=10)])
    assert totals.has_issues is False
    assert totals.subtotal_uzs == 25_000
    assert totals.item_count == 12


def test_money_stays_integer_for_large_amounts() -> None:
    _, totals = evaluate_cart([facts(price=9_999_999_999, quantity=99)])
    assert totals.subtotal_uzs == 989_999_999_901
    assert isinstance(totals.subtotal_uzs, int)
