"""User management (``admin`` role only): search users, change a role, block or unblock.

Responses never include phone numbers. A block takes effect on the user's very next request
(``403 account_blocked``; their session is revoked then). The shop always keeps at least one
active admin (``409 last_admin``) and an admin cannot block themselves
(``409 cannot_block_self``). Every change is audited (``user.role_change``, ``user.block``,
``user.unblock``) with the role/flag values only.
"""

import logging
import uuid
from typing import Annotated

from fastapi import Depends, Query

from app.api.admin_deps import (
    ADMIN_READ_LIMIT,
    ADMIN_WRITE_LIMIT,
    AdminDep,
    AdminWriterDep,
    actor_of,
    admin_required,
    back_office_router,
)
from app.api.deps import SessionDep
from app.core.errors import ApiError, error_responses
from app.models.enums import UserRole
from app.repositories.admin_users import (
    ActorNotAdminError,
    AdminUserError,
    AdminUserRepository,
    CannotBlockSelfError,
    LastAdminError,
    SqlAlchemyAdminUserRepository,
    UserNotFoundError,
)
from app.schemas.admin_users import AdminUser, AdminUserPage, UserUpdateRequest

logger = logging.getLogger("app.admin.users")

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20
MAX_PAGE = 100_000

router = back_office_router("/admin/users", tags=["admin-users"])


def get_admin_user_repository(session: SessionDep) -> AdminUserRepository:
    return SqlAlchemyAdminUserRepository(session)


AdminUserRepositoryDep = Annotated[AdminUserRepository, Depends(get_admin_user_repository)]


def to_api_error(exc: AdminUserError) -> ApiError:
    errors: dict[type[AdminUserError], ApiError] = {
        UserNotFoundError: ApiError(404, "user_not_found", "User not found"),
        LastAdminError: ApiError(409, "last_admin", "At least one active admin must remain"),
        CannotBlockSelfError: ApiError(409, "cannot_block_self", "You cannot block yourself"),
        ActorNotAdminError: admin_required(),
    }
    return errors.get(type(exc), ApiError(500, "internal_error", "Internal server error"))


@router.get(
    "",
    response_model=AdminUserPage,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_users(  # noqa: PLR0917 - FastAPI injects every parameter
    _: AdminDep,
    users: AdminUserRepositoryDep,
    q: Annotated[
        str | None,
        Query(max_length=100, description="Name or username (substring), or a Telegram id"),
    ] = None,
    role: UserRole | None = None,
    blocked: bool | None = None,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> AdminUserPage:
    """Users, newest first, optionally filtered by search text, role and blocked state."""
    record = await users.list_users(
        query=(q or "").strip() or None,
        role=role,
        blocked=blocked,
        page=page,
        page_size=page_size,
    )
    return AdminUserPage.from_record(record, page=page, page_size=page_size)


@router.patch(
    "/{user_id}",
    response_model=AdminUser,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def update_user(
    user_id: uuid.UUID,
    payload: UserUpdateRequest,
    admin: AdminWriterDep,
    users: AdminUserRepositoryDep,
) -> AdminUser:
    """Change a user's ``role`` and/or ``is_blocked``. Removing the last active admin is
    ``409 last_admin``; blocking yourself is ``409 cannot_block_self``."""
    try:
        record = await users.update_user(
            user_id, role=payload.role, is_blocked=payload.is_blocked, actor=actor_of(admin)
        )
    except AdminUserError as exc:
        raise to_api_error(exc) from None
    logger.info("User %s updated by an admin", user_id)
    return AdminUser.from_record(record)
