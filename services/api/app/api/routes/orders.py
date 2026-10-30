"""Checkout quote, order creation and the customer's own orders. Session required everywhere;
writes (every POST here) also need the CSRF token.

Every route is first limited per IP (``orders_ip``, before the session lookup), then per user.
Every response (errors included) is ``Cache-Control: no-store``. Orders are looked up by id *and*
the signed-in user, so another customer's order is indistinguishable from a missing one (404).
Request bodies (addresses, phone numbers) are never logged.
"""

import hashlib
import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from app.api.auth_deps import CsrfProtectedUserDep, CurrentUserDep, rate_limit
from app.api.deps import SessionDep
from app.core.errors import ApiError, error_responses
from app.domain.checkout import (
    BelowMinimumOrderError,
    CartEmptyError,
    CheckoutError,
    DistrictNotServedError,
    IdempotencyKeyConflictError,
    InvalidStatusTransitionError,
    OrderInsufficientStockError,
    OrderNotCancellableError,
    OrderNotFoundError,
    OrderProductUnavailableError,
    OrderStatusConflictError,
    PriceChangedError,
    TooManyOpenOrdersError,
)
from app.domain.delivery import utc_now_from
from app.repositories.orders import NewOrder, OrderRepository, SqlAlchemyOrderRepository
from app.schemas.checkout import (
    CancelOrderRequest,
    CheckoutQuote,
    CheckoutQuoteRequest,
    CreateOrderRequest,
    OrderDetail,
    OrderPage,
)
from app.security.rate_limit import (
    CHECKOUT_QUOTE,
    ORDER_CANCEL,
    ORDER_CREATE,
    ORDER_READ,
    ORDERS_IP,
)

logger = logging.getLogger("app.orders")

MAX_PAGE_SIZE = 50
DEFAULT_PAGE_SIZE = 20
MAX_PAGE = 100_000
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9_-]{16,128}$"
REPLAY_HEADER = "Idempotent-Replayed"


# Module-level so tests can replace these exact dependency objects in ``dependency_overrides``.
ORDERS_IP_LIMIT = rate_limit(ORDERS_IP.scope, ORDERS_IP.limit, ORDERS_IP.window_seconds, key="ip")
CHECKOUT_QUOTE_LIMIT = rate_limit(
    CHECKOUT_QUOTE.scope, CHECKOUT_QUOTE.limit, CHECKOUT_QUOTE.window_seconds, key="user"
)
ORDER_CREATE_LIMIT = rate_limit(
    ORDER_CREATE.scope, ORDER_CREATE.limit, ORDER_CREATE.window_seconds, key="user"
)
ORDER_READ_LIMIT = rate_limit(
    ORDER_READ.scope, ORDER_READ.limit, ORDER_READ.window_seconds, key="user"
)
ORDER_CANCEL_LIMIT = rate_limit(
    ORDER_CANCEL.scope, ORDER_CANCEL.limit, ORDER_CANCEL.window_seconds, key="user"
)

checkout_router = APIRouter(
    prefix="/checkout", tags=["checkout"], dependencies=[Depends(ORDERS_IP_LIMIT)]
)
router = APIRouter(prefix="/orders", tags=["orders"], dependencies=[Depends(ORDERS_IP_LIMIT)])


def get_order_repository(session: SessionDep) -> OrderRepository:
    return SqlAlchemyOrderRepository(session)


def get_now(request: Request) -> datetime:
    return utc_now_from(request.app.state.clock())


OrderRepositoryDep = Annotated[OrderRepository, Depends(get_order_repository)]
NowDep = Annotated[datetime, Depends(get_now)]


def to_api_error(exc: CheckoutError) -> ApiError:  # noqa: PLR0911 - one branch per rule
    """Map a checkout/order rule violation to its public error."""
    if isinstance(exc, OrderInsufficientStockError):
        return ApiError(
            409,
            "insufficient_stock",
            "Not enough stock",
            available_quantity=exc.available_quantity,
            product_id=str(exc.product_id),
        )
    if isinstance(exc, OrderProductUnavailableError):
        return ApiError(
            409, "product_inactive", "Product is not available", product_id=str(exc.product_id)
        )
    if isinstance(exc, PriceChangedError):
        return ApiError(409, "price_changed", "Order total has changed", total_uzs=exc.total_uzs)
    if isinstance(exc, OrderNotCancellableError):
        return ApiError(
            409,
            "order_not_cancellable",
            "Order can no longer be cancelled",
            current_status=exc.current_status,
        )
    if isinstance(exc, OrderStatusConflictError):
        return ApiError(
            409,
            "order_status_conflict",
            "Order status has changed",
            current_status=exc.current_status,
        )
    if isinstance(exc, InvalidStatusTransitionError):
        return ApiError(
            409,
            "invalid_status_transition",
            "Status change not allowed",
            current_status=exc.current_status,
        )
    simple: dict[type[CheckoutError], ApiError] = {
        DistrictNotServedError: ApiError(
            409, "district_not_served", "No delivery to this district"
        ),
        CartEmptyError: ApiError(409, "cart_empty", "Cart is empty"),
        BelowMinimumOrderError: ApiError(409, "below_min_order", "Order is below the minimum"),
        IdempotencyKeyConflictError: ApiError(
            409, "idempotency_key_conflict", "Idempotency key was used for a different order"
        ),
        OrderNotFoundError: ApiError(404, "order_not_found", "Order not found"),
        TooManyOpenOrdersError: ApiError(
            409, "too_many_open_orders", "Too many orders waiting for confirmation"
        ),
    }
    return simple.get(type(exc), ApiError(500, "internal_error", "Internal server error"))


def request_hash(payload: CreateOrderRequest) -> str:
    """Fingerprint of the *validated* request, so cosmetic differences (spacing in the phone
    number, surrounding whitespace) do not make a retry look like a different order."""
    return hashlib.sha256(payload.model_dump_json().encode()).hexdigest()


@checkout_router.post(
    "/quote",
    response_model=CheckoutQuote,
    dependencies=[Depends(CHECKOUT_QUOTE_LIMIT)],
    responses=error_responses(401, 403, 409, 422, 429, 503),
)
async def quote(
    payload: CheckoutQuoteRequest,
    user: CsrfProtectedUserDep,
    orders: OrderRepositoryDep,
    now: NowDep,
) -> CheckoutQuote:
    """Re-check the cart (status, current price, stock) and price delivery for a district.

    Never fails because of the cart's contents: problems are reported in ``issues`` and
    ``can_place_order``. ``409 district_not_served`` when no active zone covers the district.
    """
    try:
        record = await orders.quote(user.id, payload.district)
    except CheckoutError as exc:
        raise to_api_error(exc) from None
    return CheckoutQuote.from_record(record, now)


@router.post(
    "",
    response_model=OrderDetail,
    status_code=201,
    dependencies=[Depends(ORDER_CREATE_LIMIT)],
    responses={
        200: {"model": OrderDetail, "description": "Replay of an earlier identical request"},
        **error_responses(401, 403, 409, 422, 429, 503),
    },
)
async def create_order(  # noqa: PLR0917 - FastAPI injects every parameter
    payload: CreateOrderRequest,
    response: Response,
    user: CsrfProtectedUserDep,
    orders: OrderRepositoryDep,
    now: NowDep,
    idempotency_key: Annotated[
        str,
        Header(
            alias="Idempotency-Key",
            pattern=IDEMPOTENCY_KEY_PATTERN,
            description="Client-generated, unique per order attempt (a UUID). Required.",
        ),
    ],
) -> OrderDetail:
    """Place an order from the whole cart.

    The same ``Idempotency-Key`` with the same body returns the original order (``200`` and
    ``Idempotent-Replayed: true``); with a different body it is ``409 idempotency_key_conflict``.
    """
    new_order = NewOrder(
        district=payload.address.district,
        address=payload.address.model_dump(mode="json"),
        recipient_name=payload.recipient_name,
        recipient_phone=payload.recipient_phone,
        payment_method=payload.payment_method,
        comment=payload.comment,
        expected_total_uzs=payload.expected_total_uzs,
    )
    try:
        created = await orders.create_order(
            user.id,
            new_order,
            idempotency_key=idempotency_key,
            request_hash=request_hash(payload),
            now=now,
        )
    except CheckoutError as exc:
        logger.info("Order refused: %s", type(exc).__name__)
        raise to_api_error(exc) from None
    if created.replayed:
        response.status_code = 200
        response.headers[REPLAY_HEADER] = "true"
    else:
        logger.info("Order created: %s", created.order.id)
    return OrderDetail.from_record(created.order)


@router.get(
    "",
    response_model=OrderPage,
    dependencies=[Depends(ORDER_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_orders(
    user: CurrentUserDep,
    orders: OrderRepositoryDep,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> OrderPage:
    """The signed-in customer's orders, newest first."""
    record = await orders.list_for_user(user.id, page=page, page_size=page_size)
    return OrderPage.from_record(record, page=page, page_size=page_size)


@router.get(
    "/{order_id}",
    response_model=OrderDetail,
    dependencies=[Depends(ORDER_READ_LIMIT)],
    responses=error_responses(401, 403, 404, 422, 429, 503),
)
async def get_order(
    order_id: uuid.UUID, user: CurrentUserDep, orders: OrderRepositoryDep
) -> OrderDetail:
    record = await orders.get_for_user(user.id, order_id)
    if record is None:
        raise to_api_error(OrderNotFoundError())
    return OrderDetail.from_record(record)


@router.post(
    "/{order_id}/cancel",
    response_model=OrderDetail,
    dependencies=[Depends(ORDER_CANCEL_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def cancel_order(
    order_id: uuid.UUID,
    payload: CancelOrderRequest,
    user: CsrfProtectedUserDep,
    orders: OrderRepositoryDep,
) -> OrderDetail:
    """Cancel while the order is ``NEW`` or ``CONFIRMED``; tracked stock is returned."""
    try:
        record = await orders.cancel_for_user(user.id, order_id, payload.reason)
    except CheckoutError as exc:
        raise to_api_error(exc) from None
    logger.info("Order cancelled by customer: %s", order_id)
    return OrderDetail.from_record(record)
