"""Back-office access control shared by every ``/admin/**`` router.

Two roles reach the back office. ``operator`` works orders (and reads the dashboard); ``admin``
additionally manages the catalog, delivery zones and slots, users, CSV import/export and reads the
audit log. The role is re-read from the database on every request (``CurrentUserDep``), so a
demotion or block takes effect immediately, and it is checked **before** any entity is read, so a
wrong role gets the same ``403 forbidden`` for existing and unknown ids. The admin web app is not
a security boundary: this API enforces every rule on its own.

Back-office routes accept only Telegram **Login Widget** sessions (the admin app's sign-in). A
Mini App (``initData``) session is a storefront session: its token lives where storefront scripts
run and ``initData`` can be replayed for up to an hour, so it is never a back-office credential.
"""

from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.auth_deps import CsrfProtectedUserDep, CurrentSessionDep, CurrentUserDep, rate_limit
from app.audit import AuditActor
from app.core.errors import ApiError
from app.models.enums import UserRole
from app.repositories.users import UserRecord
from app.security.rate_limit import ADMIN_IP, ADMIN_READ, ADMIN_WRITE

STAFF_ROLES = frozenset({UserRole.OPERATOR, UserRole.ADMIN})
ADMIN_ROLES = frozenset({UserRole.ADMIN})

# Module-level so tests can replace these exact dependency objects in ``dependency_overrides``.
ADMIN_IP_LIMIT = rate_limit(ADMIN_IP.scope, ADMIN_IP.limit, ADMIN_IP.window_seconds, key="ip")
ADMIN_READ_LIMIT = rate_limit(
    ADMIN_READ.scope, ADMIN_READ.limit, ADMIN_READ.window_seconds, key="user"
)
ADMIN_WRITE_LIMIT = rate_limit(
    ADMIN_WRITE.scope, ADMIN_WRITE.limit, ADMIN_WRITE.window_seconds, key="user"
)


def staff_required() -> ApiError:
    return ApiError(403, "forbidden", "Operator role required")


def admin_required() -> ApiError:
    return ApiError(403, "forbidden", "Admin role required")


async def require_back_office_session(auth: CurrentSessionDep) -> None:
    """Refuse anything but a Login Widget session (see the module docstring)."""
    if auth.session.auth_method != "telegram_login_widget":
        raise staff_required()


def back_office_router(prefix: str, tags: Sequence[str]) -> APIRouter:
    """A router whose every route is IP-limited and needs a back-office session."""
    return APIRouter(
        prefix=prefix,
        tags=list(tags),
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


async def require_admin(user: CurrentUserDep) -> UserRecord:
    if user.role not in ADMIN_ROLES:
        raise admin_required()
    return user


async def require_admin_writer(user: CsrfProtectedUserDep) -> UserRecord:
    if user.role not in ADMIN_ROLES:
        raise admin_required()
    return user


def actor_of(user: UserRecord) -> AuditActor:
    return AuditActor(user_id=user.id, role=user.role)


StaffDep = Annotated[UserRecord, Depends(require_staff)]
StaffWriterDep = Annotated[UserRecord, Depends(require_staff_writer)]
AdminDep = Annotated[UserRecord, Depends(require_admin)]
AdminWriterDep = Annotated[UserRecord, Depends(require_admin_writer)]
