"""Signed-in user's cart. Reads need a session; writes also need the CSRF token."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.api.auth_deps import CsrfProtectedUserDep, CurrentUserDep, rate_limit
from app.api.deps import SessionDep
from app.core.errors import ApiError, ErrorCode, error_responses
from app.domain.cart import (
    CartError,
    CartItemNotFoundError,
    CartLimitReachedError,
    InsufficientStockError,
    ProductInactiveError,
    ProductNotFoundError,
    QuantityLimitExceededError,
)
from app.repositories.cart import CartRepository, SqlAlchemyCartRepository
from app.schemas.cart import AddCartItemRequest, Cart, SetCartItemQuantityRequest

# Module-level so tests can replace these exact dependency objects in ``dependency_overrides``.
CART_READ_LIMIT = rate_limit("cart_read", 120, 60, key="user")
CART_WRITE_LIMIT = rate_limit("cart_write", 60, 60, key="user")


async def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/cart", tags=["cart"], dependencies=[Depends(no_store)])


def get_cart_repository(session: SessionDep) -> CartRepository:
    return SqlAlchemyCartRepository(session)


CartRepositoryDep = Annotated[CartRepository, Depends(get_cart_repository)]

_READ_ERRORS = error_responses(401, 403, 429)
_WRITE_ERRORS = error_responses(401, 403, 404, 409, 422, 429)


_SIMPLE_ERRORS: dict[type[CartError], tuple[int, ErrorCode, str]] = {
    ProductNotFoundError: (404, "product_not_found", "Product not found"),
    CartItemNotFoundError: (404, "cart_item_not_found", "Cart item not found"),
    ProductInactiveError: (409, "product_inactive", "Product is not available"),
    CartLimitReachedError: (409, "cart_limit_reached", "Cart has too many items"),
}


def to_api_error(exc: CartError) -> ApiError:
    """Map a cart rule violation to its public error."""
    if isinstance(exc, InsufficientStockError):
        return ApiError(
            409, "insufficient_stock", "Not enough stock", available_quantity=exc.available_quantity
        )
    if isinstance(exc, QuantityLimitExceededError):
        return ApiError(
            422,
            "validation_error",
            "Request validation failed",
            details=[{"loc": ["body", "quantity"], "msg": "Quantity per item cannot exceed 99"}],
        )
    status_code, code, message = _SIMPLE_ERRORS.get(
        type(exc), (500, "internal_error", "Internal server error")
    )
    return ApiError(status_code, code, message)


@router.get(
    "",
    response_model=Cart,
    dependencies=[Depends(CART_READ_LIMIT)],
    responses=_READ_ERRORS,
)
async def get_cart(user: CurrentUserDep, carts: CartRepositoryDep) -> Cart:
    return Cart.from_record(await carts.get_cart(user.id))


@router.post(
    "/items",
    response_model=Cart,
    dependencies=[Depends(CART_WRITE_LIMIT)],
    responses=_WRITE_ERRORS,
)
async def add_cart_item(
    payload: AddCartItemRequest, user: CsrfProtectedUserDep, carts: CartRepositoryDep
) -> Cart:
    """Add ``quantity`` to the line for ``product_id`` (creating it if needed)."""
    try:
        record = await carts.add_item(user.id, payload.product_id, payload.quantity)
    except CartError as exc:
        raise to_api_error(exc) from None
    return Cart.from_record(record)


@router.put(
    "/items/{product_id}",
    response_model=Cart,
    dependencies=[Depends(CART_WRITE_LIMIT)],
    responses=_WRITE_ERRORS,
)
async def set_cart_item_quantity(
    product_id: uuid.UUID,
    payload: SetCartItemQuantityRequest,
    user: CsrfProtectedUserDep,
    carts: CartRepositoryDep,
) -> Cart:
    """Set the quantity of an existing line."""
    try:
        record = await carts.set_item_quantity(user.id, product_id, payload.quantity)
    except CartError as exc:
        raise to_api_error(exc) from None
    return Cart.from_record(record)


@router.delete(
    "/items/{product_id}",
    response_model=Cart,
    dependencies=[Depends(CART_WRITE_LIMIT)],
    responses=_WRITE_ERRORS,
)
async def remove_cart_item(
    product_id: uuid.UUID, user: CsrfProtectedUserDep, carts: CartRepositoryDep
) -> Cart:
    """Remove a line. Idempotent: removing a missing line still returns the cart."""
    return Cart.from_record(await carts.remove_item(user.id, product_id))
