"""Public auth routes: Telegram sign-in, session lookup and logout (ADR 0004, ADR 0007).

Every response under ``/auth`` is ``Cache-Control: no-store`` (see ``SessionCookieMiddleware``).
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.api.auth_deps import (
    CurrentSessionDep,
    clear_session_cookie,
    csrf_failed,
    get_session_manager,
    rate_limit,
    require_trusted_origin,
    session_token_from,
    set_session_cookie,
    store_unavailable,
)
from app.api.deps import UserRepositoryDep, get_identity_verifier
from app.core.config import Settings
from app.core.errors import ApiError, error_responses
from app.repositories.users import TelegramProfile, UserRepository
from app.schemas.auth import (
    AuthConfigResponse,
    LoginWidgetConfig,
    LoginWidgetRequest,
    SessionResponse,
)
from app.schemas.users import InitDataRequest, UserPublic
from app.security.csrf import CSRF_HEADER, CsrfError, check_token
from app.security.rate_limit import AUTH_LOGIN, AUTH_SESSION
from app.security.session import AuthMethod, SessionManager, StoreUnavailableError
from app.telegram.identity import (
    InvalidInitData,
    TelegramIdentityVerifier,
    VerifiedTelegramIdentity,
)
from app.telegram.login_widget import InvalidLoginWidgetData, LoginWidgetVerifier

logger = logging.getLogger("app.auth")
router = APIRouter(prefix="/auth", tags=["auth"])

login_rate_limit = rate_limit(AUTH_LOGIN.scope, AUTH_LOGIN.limit, AUTH_LOGIN.window_seconds)
session_rate_limit = rate_limit(AUTH_SESSION.scope, AUTH_SESSION.limit, AUTH_SESSION.window_seconds)
SessionManagerDep = Annotated[SessionManager, Depends(get_session_manager)]


def _invalid_telegram_auth(message: str) -> ApiError:
    return ApiError(401, "invalid_telegram_auth", message)


def get_login_widget_verifier(request: Request) -> LoginWidgetVerifier:
    """404 ``feature_disabled`` unless ``TELEGRAM_LOGIN_WIDGET_ENABLED`` (checked first)."""
    verifier: LoginWidgetVerifier | None = request.app.state.login_widget_verifier
    if verifier is None:
        raise ApiError(404, "feature_disabled", "Telegram Login Widget is disabled")
    return verifier


async def _sign_in(
    request: Request,
    identity: VerifiedTelegramIdentity,
    auth_method: AuthMethod,
    users: UserRepository,
    manager: SessionManager,
) -> SessionResponse:
    """Upsert the verified user and replace whatever session the request presented."""
    user = await users.upsert_from_telegram(
        TelegramProfile(
            telegram_user_id=identity.telegram_user_id,
            first_name=identity.first_name,
            last_name=identity.last_name,
            username=identity.username,
            language_code=identity.language_code,
        )
    )
    previous_token = session_token_from(request)
    try:
        if user.is_blocked:
            if previous_token is not None:
                await manager.revoke(previous_token)
                clear_session_cookie(request)
            raise ApiError(403, "account_blocked", "Account is blocked")
        issued = await manager.create(
            user_id=user.id,
            telegram_user_id=user.telegram_user_id,
            auth_method=auth_method,
            previous_token=previous_token,
        )
    except StoreUnavailableError:
        logger.error("Session store unavailable during sign-in; failing closed")  # noqa: TRY400
        raise store_unavailable() from None
    set_session_cookie(request, issued)
    return SessionResponse(user=UserPublic.model_validate(user), csrf_token=issued.data.csrf_token)


_LOGIN_ERRORS = error_responses(401, 403, 422, 429, 503)


@router.get("/config", response_model=AuthConfigResponse)
async def auth_config(request: Request) -> AuthConfigResponse:
    """Which sign-in methods the website may offer."""
    settings: Settings = request.app.state.settings
    enabled = settings.telegram_login_widget_enabled
    return AuthConfigResponse(
        telegram_login_widget=LoginWidgetConfig(
            enabled=enabled,
            bot_username=settings.telegram_bot_username if enabled else None,
        )
    )


@router.post(
    "/telegram/init-data",
    response_model=SessionResponse,
    responses=_LOGIN_ERRORS,
    dependencies=[Depends(login_rate_limit), Depends(require_trusted_origin)],
)
async def sign_in_with_init_data(
    request: Request,
    payload: InitDataRequest,
    verifier: Annotated[TelegramIdentityVerifier, Depends(get_identity_verifier)],
    users: UserRepositoryDep,
    manager: SessionManagerDep,
) -> SessionResponse:
    """Verify Telegram Mini App ``initData``, upsert the user and start a cookie session."""
    try:
        identity = verifier.verify(payload.init_data)
    except InvalidInitData as exc:
        logger.info("Rejected Telegram init data: %s", exc.reason)
        raise _invalid_telegram_auth("Invalid Telegram init data") from None
    return await _sign_in(request, identity, "telegram_init_data", users, manager)


@router.post(
    "/telegram/login-widget",
    response_model=SessionResponse,
    responses=error_responses(401, 403, 404, 422, 429, 503),
    # Feature flag first: a disabled endpoint answers 404 before anything else happens.
    dependencies=[
        Depends(get_login_widget_verifier),
        Depends(login_rate_limit),
        Depends(require_trusted_origin),
    ],
)
async def sign_in_with_login_widget(
    request: Request,
    verifier: Annotated[LoginWidgetVerifier, Depends(get_login_widget_verifier)],
    payload: LoginWidgetRequest,
    users: UserRepositoryDep,
    manager: SessionManagerDep,
) -> SessionResponse:
    """Verify a Telegram Login Widget payload (website) and start a cookie session."""
    try:
        identity = verifier.verify(payload.signed_fields())
    except InvalidLoginWidgetData as exc:
        logger.info("Rejected Telegram Login Widget data: %s", exc.reason)
        raise _invalid_telegram_auth("Invalid Telegram login data") from None
    return await _sign_in(request, identity, "telegram_login_widget", users, manager)


@router.get(
    "/session",
    response_model=SessionResponse,
    responses=error_responses(401, 403, 429, 503),
    dependencies=[Depends(session_rate_limit)],
)
async def get_session(auth: CurrentSessionDep) -> SessionResponse:
    """The signed-in user and the CSRF token (e.g. after a page reload)."""
    return SessionResponse(
        user=UserPublic.model_validate(auth.user), csrf_token=auth.session.csrf_token
    )


@router.post(
    "/logout",
    status_code=204,
    response_class=Response,
    responses=error_responses(403, 429, 503),
    dependencies=[Depends(session_rate_limit), Depends(require_trusted_origin)],
)
async def logout(request: Request, manager: SessionManagerDep) -> None:
    """Delete the session (if any) and expire the cookie. Idempotent.

    When a live session is presented, ``X-CSRF-Token`` must match it, so a cross-site request
    cannot sign the user out.
    """
    token = session_token_from(request)
    if token is not None:
        try:
            session = await manager.peek(token)
            if session is not None:
                try:
                    check_token(session.csrf_token, request.headers.get(CSRF_HEADER))
                except CsrfError as exc:
                    logger.info("CSRF check failed on logout: %s", exc.reason)
                    raise csrf_failed() from None
                await manager.revoke(token)
        except StoreUnavailableError:
            logger.error("Session store unavailable during logout; failing closed")  # noqa: TRY400
            raise store_unavailable() from None
    clear_session_cookie(request)
