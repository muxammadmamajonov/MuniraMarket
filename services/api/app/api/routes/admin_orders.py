"""Operator/admin back office: list orders, read one, change its status.

Only ``operator`` and ``admin`` users get past ``require_staff`` (``app/api/admin_deps.py``: role
re-read on every request, Login Widget sessions only). Every response is ``Cache-Control:
no-store``. Recipient details are visible here because delivery needs them; they are never logged
and never written to the audit log.
"""

import logging
import uuid
from typing import Annotated

from fastapi import Depends, Query

from app.api.admin_deps import (
    ADMIN_READ_LIMIT,
    ADMIN_WRITE_LIMIT,
    StaffDep,
    StaffWriterDep,
    back_office_router,
)
from app.api.routes.orders import MAX_PAGE, MAX_PAGE_SIZE, OrderRepositoryDep, to_api_error
from app.core.errors import error_responses
from app.domain.checkout import CheckoutError, OrderNotFoundError
from app.domain.order_status import OrderStatus
from app.repositories.orders import Actor
from app.schemas.checkout import AdminOrderDetail, OrderPage, OrderStatusUpdateRequest

logger = logging.getLogger("app.admin.orders")

router = back_office_router("/admin/orders", tags=["admin"])

_ERRORS = error_responses(401, 403, 404, 422, 429, 503)


@router.get(
    "",
    response_model=OrderPage,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_orders(
    _: StaffDep,
    orders: OrderRepositoryDep,
    status: OrderStatus | None = None,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 20,
) -> OrderPage:
    """All orders (optionally one status), newest first."""
    record = await orders.list_all(status=status, page=page, page_size=page_size)
    return OrderPage.from_record(record, page=page, page_size=page_size)


@router.get(
    "/{order_id}",
    response_model=AdminOrderDetail,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=_ERRORS,
)
async def get_order(
    order_id: uuid.UUID, _: StaffDep, orders: OrderRepositoryDep
) -> AdminOrderDetail:
    record = await orders.get(order_id)
    if record is None:
        raise to_api_error(OrderNotFoundError())
    return AdminOrderDetail.from_admin_record(record)


@router.patch(
    "/{order_id}/status",
    response_model=AdminOrderDetail,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def change_status(
    order_id: uuid.UUID,
    payload: OrderStatusUpdateRequest,
    staff: StaffWriterDep,
    orders: OrderRepositoryDep,
) -> AdminOrderDetail:
    """Move an order one step forward, or cancel it (``reason`` required; stock is returned).

    Send ``expected_status`` (the status you saw) to get ``409 order_status_conflict`` instead of
    overwriting a colleague's change.
    """
    try:
        record = await orders.change_status(
            order_id,
            payload.status,
            actor=Actor(user_id=staff.id, role=staff.role),
            reason=payload.reason,
            expected_status=payload.expected_status,
        )
    except CheckoutError as exc:
        raise to_api_error(exc) from None
    logger.info("Order %s moved to %s by %s", order_id, payload.status.value, staff.role.value)
    return AdminOrderDetail.from_admin_record(record)
