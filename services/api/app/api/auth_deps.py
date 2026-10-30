"""Browser-session dependencies shared by every authenticated public route (ADR 0007).

INTERFACE CONTRACT (catalog/cart code depends on these names and semantics):

- ``CurrentUserDep``: the ``UserRecord`` of the signed-in, non-blocked user. Raises
  ``ApiError(401, "session_required")`` without a valid session cookie and
  ``ApiError(403, "account_blocked")`` for blocked users (their session is deleted). The user is
  re-read from the database on every request. A session due for rotation gets a new token via
  ``Set-Cookie`` (delivered even if the route then fails).
- ``CsrfProtectedUserDep``: same as ``CurrentUserDep`` but additionally enforces the CSRF rules
  (``ApiError(403, "csrf_failed")``): trusted ``Origin`` and ``X-CSRF-Token`` equal to the
  session's token. Use it on every state-changing route (POST/PUT/PATCH/DELETE).
- ``rate_limit(scope, limit, window_seconds, key="ip" | "user")``: returns a dependency that
  raises ``ApiError(429, "rate_limited", headers={"Retry-After": ...})`` once exceeded.
  ``key="user"`` depends on ``get_current_user`` (so it also requires a session).
- Store (Redis) failures raise ``ApiError(503, "service_unavailable")``: fail closed.

Tests override ``get_current_user`` (and ``require_csrf`` for write routes when not testing
CSRF itself) and may override ``get_rate_limiter`` / ``get_session_manager`` via
``app.dependency_overrides``.
"""

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, Request

from app.api.deps import UserRepositoryDep
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.users import UserRecord
from app.security.cookies import (
    expired_cookie_header,
    queue_session_cookie,
    session_cookie_header,
)
from app.security.csrf import CSRF_HEADER, CsrfError, check_origin, check_token, is_unsafe_method
from app.security.rate_limit import RateLimiter
from app.security.session import (
    IssuedSession,
    SessionData,
    SessionGoneError,
    SessionManager,
    StoreUnavailableError,
)

logger = logging.getLogger("app.auth")

_SCOPE_RE = re.compile(r"[a-z][a-z0-9_]{0,63}")


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    user: UserRecord
    session: SessionData


# --- shared state ----------------------------------------------------------------------------


def get_session_manager(request: Request) -> SessionManager:
    manager: SessionManager = request.app.state.session_manager
    return manager


def get_rate_limiter(request: Request) -> RateLimiter:
    limiter: RateLimiter = request.app.state.rate_limiter
    return limiter


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def store_unavailable() -> ApiError:
    return ApiError(503, "service_unavailable", "Service temporarily unavailable")


def session_required() -> ApiError:
    return ApiError(401, "session_required", "Sign-in required")


def account_blocked() -> ApiError:
    return ApiError(403, "account_blocked", "Account is blocked")


def csrf_failed() -> ApiError:
    return ApiError(403, "csrf_failed", "CSRF validation failed")


# --- cookie helpers ----------------------------------------------------------------------------


def session_token_from(request: Request) -> str | None:
    return request.cookies.get(_settings(request).session_cookie_name) or None


def set_session_cookie(request: Request, issued: IssuedSession) -> None:
    settings = _settings(request)
    queue_session_cookie(
        request,
        session_cookie_header(
            name=settings.session_cookie_name,
            token=issued.token,
            max_age=issued.max_age_seconds,
            secure=settings.session_cookie_secure,
        ),
    )


def clear_session_cookie(request: Request) -> None:
    settings = _settings(request)
    queue_session_cookie(
        request,
        expired_cookie_header(
            name=settings.session_cookie_name, secure=settings.session_cookie_secure
        ),
    )


# --- session / user ------------------------------------------------------------------------------


async def get_current_session(
    request: Request,
    manager: Annotated[SessionManager, Depends(get_session_manager)],
    users: UserRepositoryDep,
) -> AuthenticatedSession:
    token = session_token_from(request)
    if token is None:
        raise session_required()
    try:
        loaded = await manager.load(token)
        if loaded is None:
            clear_session_cookie(request)
            raise session_required()
        user = await users.get_by_id(loaded.data.user_id)
        if user is None or user.telegram_user_id != loaded.data.telegram_user_id:
            await manager.revoke(token)
            clear_session_cookie(request)
            raise session_required()
        if user.is_blocked:
            # Blocking takes effect on the very next request.
            await manager.revoke(token)
            clear_session_cookie(request)
            raise account_blocked()
        try:
            rotated = await manager.rotate_if_due(loaded)
        except SessionGoneError:
            # Logged out / blocked concurrently: nothing to rotate, nothing to set.
            raise session_required() from None
    except StoreUnavailableError:
        logger.error("Session store unavailable; failing closed")  # noqa: TRY400 - no details
        raise store_unavailable() from None
    if rotated is None:
        return AuthenticatedSession(user=user, session=loaded.data)
    set_session_cookie(request, rotated)
    return AuthenticatedSession(user=user, session=rotated.data)


async def get_current_user(
    auth: Annotated[AuthenticatedSession, Depends(get_current_session)],
) -> UserRecord:
    return auth.user


# --- CSRF --------------------------------------------------------------------------------------


def _enforce_origin(request: Request) -> None:
    settings = _settings(request)
    check_origin(
        request.headers,
        trusted_origins=settings.csrf_trusted_origins,
        app_env=settings.app_env,
    )


async def require_trusted_origin(request: Request) -> None:
    """Origin check only. For unsafe requests that have no session yet (login, logout)."""
    if not is_unsafe_method(request.method):
        return
    try:
        _enforce_origin(request)
    except CsrfError as exc:
        logger.info("CSRF origin check failed: %s", exc.reason)
        raise csrf_failed() from None


async def require_csrf(
    request: Request,
    auth: Annotated[AuthenticatedSession, Depends(get_current_session)],
) -> None:
    """Origin check plus the session-bound synchronizer token, for unsafe methods."""
    if not is_unsafe_method(request.method):
        return
    try:
        _enforce_origin(request)
        check_token(auth.session.csrf_token, request.headers.get(CSRF_HEADER))
    except CsrfError as exc:
        logger.info("CSRF check failed: %s", exc.reason)
        raise csrf_failed() from None


async def get_csrf_protected_user(
    user: Annotated[UserRecord, Depends(get_current_user)],
    _: Annotated[None, Depends(require_csrf)],
) -> UserRecord:
    return user


# --- rate limiting -----------------------------------------------------------------------------


def client_ip(request: Request) -> str:
    """The peer address. Behind a proxy uvicorn must run with ``--proxy-headers
    --forwarded-allow-ips=<proxy>`` so this is the real client (never parse XFF here)."""
    return request.client.host if request.client else "unknown"


async def _enforce_limit(
    limiter: RateLimiter, scope: str, subject: str, limit: int, window_seconds: int
) -> None:
    try:
        decision = await limiter.hit(scope, subject, limit=limit, window_seconds=window_seconds)
    except StoreUnavailableError:
        logger.error("Rate limiter unavailable; failing closed (scope=%s)", scope)  # noqa: TRY400
        raise store_unavailable() from None
    if not decision.allowed:
        logger.info("Rate limit exceeded (scope=%s)", scope)
        raise ApiError(
            429,
            "rate_limited",
            "Too many requests",
            headers={"Retry-After": str(decision.retry_after_seconds)},
        )


def rate_limit(
    scope: str,
    limit: int,
    window_seconds: int,
    key: Literal["ip", "user"] = "ip",
) -> Callable[..., Awaitable[None]]:
    if not _SCOPE_RE.fullmatch(scope) or limit <= 0 or window_seconds <= 0:
        raise ValueError("rate_limit needs a lower-case scope and positive limit/window")

    if key == "ip":

        async def by_ip(
            request: Request,
            limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
        ) -> None:
            await _enforce_limit(limiter, scope, client_ip(request), limit, window_seconds)

        return by_ip

    async def by_user(
        user: Annotated[UserRecord, Depends(get_current_user)],
        limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    ) -> None:
        await _enforce_limit(limiter, scope, str(user.id), limit, window_seconds)

    return by_user


CurrentSessionDep = Annotated[AuthenticatedSession, Depends(get_current_session)]
CurrentUserDep = Annotated[UserRecord, Depends(get_current_user)]
CsrfProtectedUserDep = Annotated[UserRecord, Depends(get_csrf_protected_user)]
