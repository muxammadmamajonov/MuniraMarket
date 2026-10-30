"""Browser-session dependencies shared by every authenticated public route.

INTERFACE CONTRACT (catalog/cart code depends on these names and semantics):

- ``CurrentUserDep``: the ``UserRecord`` of the signed-in, non-blocked user. Raises
  ``ApiError(401, "session_required")`` without a valid session cookie and
  ``ApiError(403, "account_blocked")`` for blocked users.
- ``CsrfProtectedUserDep``: same as ``CurrentUserDep`` but additionally enforces the CSRF rules
  (``ApiError(403, "csrf_failed")``). Use it on every state-changing route (POST/PUT/PATCH/DELETE).
- ``rate_limit(scope, limit, window_seconds, key="ip" | "user")``: returns a dependency that
  raises ``ApiError(429, "rate_limited", headers={"Retry-After": ...})`` once exceeded.

Tests override ``get_current_user`` (and may override ``get_rate_limiter``) via
``app.dependency_overrides``.
"""

from collections.abc import Awaitable, Callable
from typing import Annotated, Literal

from fastapi import Depends, Request

from app.repositories.users import UserRecord


async def get_current_user(request: Request) -> UserRecord:
    raise NotImplementedError  # implemented by the auth/session work


async def require_csrf(request: Request) -> None:
    raise NotImplementedError  # implemented by the auth/session work


async def get_csrf_protected_user(
    user: Annotated[UserRecord, Depends(get_current_user)],
    _: Annotated[None, Depends(require_csrf)],
) -> UserRecord:
    return user


def rate_limit(
    scope: str,
    limit: int,
    window_seconds: int,
    key: Literal["ip", "user"] = "ip",
) -> Callable[..., Awaitable[None]]:
    async def dependency(request: Request) -> None:
        # Stub until the auth/session work lands.
        raise NotImplementedError((scope, limit, window_seconds, key, request))

    return dependency


CurrentUserDep = Annotated[UserRecord, Depends(get_current_user)]
CsrfProtectedUserDep = Annotated[UserRecord, Depends(get_csrf_protected_user)]
