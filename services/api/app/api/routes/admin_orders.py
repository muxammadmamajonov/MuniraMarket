"""Operator/admin back office: list orders, read one, change its status.

Only ``operator`` and ``admin`` users get past ``require_staff``; the role is re-read from the
database on every request (``CurrentUserDep``), so revoking it takes effect immediately. The
admin web app is not a security boundary: this API enforces the role on its own. Every response is
``Cache-Control: no-store``. Recipient details are visible here because delivery needs them; they
are never logged.
"""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.auth_deps import CsrfProtectedUserDep, CurrentSessionDep, CurrentUserDep, rate_limit
from app.api.routes.orders import MAX_PAGE, MAX_PAGE_SIZE, OrderRepositoryDep, to_api_error
from app.core.errors import ApiError, error_responses
from app.domain.checkout import CheckoutError, OrderNotFoundError
from app.domain.order_status import OrderStatus
from app.models.enums import UserRole
from app.repositories.orders import Actor
from app.repositories.users import UserRecord
from app.schemas.checkout import AdminOrderDetail, OrderPage, OrderStatusUpdateRequest
from app.security.rate_limit import ADMIN_IP, ADMIN_READ, ADMIN_WRITE

logger = logging.getLogger("app.admin.orders")

STAFF_ROLES = frozenset({UserRole.OPERATOR, UserRole.ADMIN})

ADMIN_IP_LIMIT = rate_limit(ADMIN_IP.scope, ADMIN_IP.limit, ADMIN_IP.window_seconds, key="ip")
ADMIN_READ_LIMIT = rate_limit(
    ADMIN_READ.scope, ADMIN_READ.limit, ADMIN_READ.window_seconds, key="user"
)
ADMIN_WRITE_LIMIT = rate_limit(
    ADMIN_WRITE.scope, ADMIN_WRITE.limit, ADMIN_WRITE.window_seconds, key="user"
)


def staff_required() -> ApiError:
    return ApiError(403, "forbidden", "Operator role required")


async def require_back_office_session(auth: CurrentSessionDep) -> None:
    """Back-office calls need a session from the Telegram Login Widget (the admin app's sign-in).

    A Mini App (``initData``) session is a storefront session: its token lives where storefront
    scripts run, and ``initData`` can be replayed for up to an hour. Refusing it here keeps a
    staff member's shopping session from being usable as a back-office credential.
    """
    if auth.session.auth_method != "telegram_login_widget":
        raise staff_required()


router = APIRouter(
    prefix="/admin/orders",
    tags=["admin"],
    dependencies=[Depends(ADMIN_IP_LIMIT), Depends(require_back_office_session)],
)


async def require_staff(user: CurrentUserDep) -> UserRecord:
    if user.role not in STAFF_ROLES:
        raise staff_required()
    return user


async def require_staff_writer(user: CsrfProtectedUserDep) -> UserRecord:
    if user.role not in STAFF_ROLES:
        raise staff_required()
    return user


StaffDep = Annotated[UserRecord, Depends(require_staff)]
StaffWriterDep = Annotated[UserRecord, Depends(require_staff_writer)]

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
