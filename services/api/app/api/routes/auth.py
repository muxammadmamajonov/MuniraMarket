"""Public auth routes: Telegram sign-in, session lookup and logout (ADR 0004, 0007, 0014).

Every response under ``/auth`` is ``Cache-Control: no-store`` (see ``SessionCookieMiddleware``).
"""

import hmac
import logging
import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import RedirectResponse

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
from app.core.clock import Clock
from app.core.config import Settings
from app.core.errors import ApiError, error_responses
from app.repositories.users import TelegramProfile, UserRepository
from app.schemas.auth import (
    AuthConfigResponse,
    OidcConfig,
    OidcStartRequest,
    OidcStartResponse,
    SessionResponse,
)
from app.schemas.users import InitDataRequest, UserPublic
from app.security.cookies import (
    binding_cookie_name,
    expired_cookie_header,
    queue_session_cookie,
    session_cookie_header,
)
from app.security.csrf import CSRF_HEADER, CsrfError, check_token
from app.security.oidc_state import OidcStateStore, PendingLogin
from app.security.rate_limit import AUTH_LOGIN, AUTH_SESSION
from app.security.session import AuthMethod, Entrance, SessionManager, StoreUnavailableError
from app.telegram.identity import (
    InvalidInitData,
    TelegramIdentityVerifier,
    VerifiedTelegramIdentity,
)
from app.telegram.oidc import (
    CALLBACK_PATH,
    OidcClient,
    OidcError,
    authorization_url,
    is_plausible_code,
    new_code_verifier,
    new_secret_value,
    sha256_hex,
)

logger = logging.getLogger("app.auth")
router = APIRouter(prefix="/auth", tags=["auth"])

login_rate_limit = rate_limit(AUTH_LOGIN.scope, AUTH_LOGIN.limit, AUTH_LOGIN.window_seconds)
session_rate_limit = rate_limit(AUTH_SESSION.scope, AUTH_SESSION.limit, AUTH_SESSION.window_seconds)
SessionManagerDep = Annotated[SessionManager, Depends(get_session_manager)]


def _invalid_telegram_auth(message: str) -> ApiError:
    return ApiError(401, "invalid_telegram_auth", message)


def request_entrance(request: Request) -> Entrance | None:
    """The browser entrance the request came through, never a client-selected value.

    Deployed: the gateway sets ``X-MM-Entrance`` on every request (its own entrypoint name) and is
    the container's only ingress; browsers cannot reach the header through either app proxy.
    Development and test, where no gateway runs, fall back to the storefront.
    """
    entrance = request.headers.get("x-mm-entrance")
    if entrance == "storefront":
        return "storefront"
    if entrance == "admin":
        return "admin"
    settings: Settings = request.app.state.settings
    return "storefront" if settings.app_env in {"development", "test"} else None


def get_oidc_client(request: Request) -> OidcClient:
    """404 ``feature_disabled`` unless Telegram OIDC sign-in is configured (checked first)."""
    client: OidcClient | None = request.app.state.oidc_client
    if client is None:
        raise ApiError(404, "feature_disabled", "Telegram sign-in is disabled")
    return client


OidcClientDep = Annotated[OidcClient, Depends(get_oidc_client)]


async def _sign_in(
    request: Request,
    identity: VerifiedTelegramIdentity,
    auth_method: AuthMethod,
    users: UserRepository,
    manager: SessionManager,
    *,
    entrance: Entrance = "storefront",
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
            entrance=entrance,
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
    """Which browser sign-in methods this origin may offer."""
    enabled = request.app.state.oidc_client is not None and request_entrance(request) is not None
    return AuthConfigResponse(telegram_oidc=OidcConfig(enabled=enabled))


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


# --- Telegram OIDC (ADR 0014) --------------------------------------------------------------------

_RETURN_TO_MAX = 512
_STATE_RE = re.compile(r"[A-Za-z0-9_-]{43}")
_LOCALES = ("uz", "ru")


def safe_return_to(value: str | None) -> str:
    """A same-origin absolute path, or ``/``. Never a scheme-relative or backslash path."""
    if value is None or not value.startswith("/") or value.startswith(("//", "/\\")):
        return "/"
    if len(value) > _RETURN_TO_MAX or any(ord(ch) < 0x20 or ch in "\\" for ch in value):
        return "/"
    return value


def _failure_location(return_to: str, reason: str) -> str:
    """The sign-in page of the locale ``return_to`` points into, with a coarse reason."""
    first = return_to.strip("/").split("/", 1)[0]
    locale = first if first in _LOCALES else _LOCALES[0]
    return f"/{locale}/auth/telegram?status={reason}"


def _redirect(location: str) -> RedirectResponse:
    # The callback URL carries the authorization code: never leak it through Referer.
    return RedirectResponse(location, status_code=303, headers={"referrer-policy": "no-referrer"})


def _binding_cookie(request: Request, value: str, max_age: int) -> str:
    settings: Settings = request.app.state.settings
    secure = settings.session_cookie_secure
    return session_cookie_header(
        name=binding_cookie_name(secure), token=value, max_age=max_age, secure=secure
    )


def _clear_binding_cookie(request: Request) -> None:
    settings: Settings = request.app.state.settings
    secure = settings.session_cookie_secure
    queue_session_cookie(
        request, expired_cookie_header(name=binding_cookie_name(secure), secure=secure)
    )


def get_oidc_state_store(request: Request) -> OidcStateStore:
    store: OidcStateStore = request.app.state.oidc_state_store
    return store


OidcStateStoreDep = Annotated[OidcStateStore, Depends(get_oidc_state_store)]


@router.post(
    "/telegram/oidc/start",
    response_model=OidcStartResponse,
    responses=error_responses(403, 404, 422, 429, 503),
    # Feature flag first: a disabled endpoint answers 404 before anything else happens.
    dependencies=[
        Depends(get_oidc_client),
        Depends(login_rate_limit),
        Depends(require_trusted_origin),
    ],
)
async def start_oidc_login(
    request: Request,
    payload: OidcStartRequest,
    oidc: OidcClientDep,
    states: OidcStateStoreDep,
) -> OidcStartResponse:
    """Begin a Telegram sign-in: returns the authorization URL the browser must navigate to.

    Sets a short-lived binding cookie; only the browser holding it can complete the login.
    """
    entrance = request_entrance(request)
    settings: Settings = request.app.state.settings
    origin = settings.public_origin(entrance) if entrance is not None else None
    if entrance is None or origin is None:
        raise ApiError(404, "feature_disabled", "Telegram sign-in is disabled")
    clock: Clock = request.app.state.clock
    state, binding, nonce = new_secret_value(), new_secret_value(), new_secret_value()
    verifier = new_code_verifier()
    try:
        await states.put(
            sha256_hex(state),
            PendingLogin(
                binding_hash=sha256_hex(binding),
                entrance=entrance,
                code_verifier=verifier,
                nonce=nonce,
                return_to=safe_return_to(payload.return_to),
                created_at=int(clock()),
            ),
            oidc.state_ttl_seconds,
        )
    except StoreUnavailableError:
        logger.error("OIDC state store unavailable; failing closed")  # noqa: TRY400
        raise store_unavailable() from None
    queue_session_cookie(request, _binding_cookie(request, binding, oidc.state_ttl_seconds))
    return OidcStartResponse(
        authorization_url=authorization_url(
            oidc.endpoints,
            client_id=oidc.client_id,
            redirect_uri=f"{origin}{CALLBACK_PATH}",
            state=state,
            nonce=nonce,
            verifier=verifier,
        )
    )


class _CallbackFailedError(Exception):
    """Ends a callback early with a redirect to the app's sign-in page."""

    def __init__(self, location: str, reason: str) -> None:
        super().__init__(reason)
        self.location = location
        self.reason = reason


async def _complete_oidc_login(
    request: Request,
    oidc: OidcClient,
    login: PendingLogin,
    code: str | None,
    *,
    users: UserRepository,
    manager: SessionManager,
) -> None:
    """Every check after the state was consumed; raises :class:`_CallbackFailedError`."""
    failed = _failure_location(login.return_to, "failed")
    settings: Settings = request.app.state.settings
    binding = request.cookies.get(binding_cookie_name(settings.session_cookie_secure))
    if binding is None or not hmac.compare_digest(
        sha256_hex(binding).encode("ascii"), login.binding_hash.encode("ascii")
    ):
        raise _CallbackFailedError(failed, "binding_mismatch")
    origin = settings.public_origin(login.entrance)
    if request_entrance(request) != login.entrance or origin is None:
        raise _CallbackFailedError(failed, "entrance_mismatch")
    if code is None or not is_plausible_code(code):
        # Covers the user cancelling on Telegram (no code, an ``error`` parameter instead).
        raise _CallbackFailedError(_failure_location(login.return_to, "cancelled"), "no_code")
    clock: Clock = request.app.state.clock
    try:
        identity = await oidc.identity_for(
            code=code,
            redirect_uri=f"{origin}{CALLBACK_PATH}",
            code_verifier=login.code_verifier,
            nonce=login.nonce,
            now=clock(),
        )
    except OidcError as exc:
        raise _CallbackFailedError(failed, exc.reason) from None
    try:
        await _sign_in(request, identity, "telegram_oidc", users, manager, entrance=login.entrance)
    except ApiError as exc:
        if exc.code == "account_blocked":
            raise _CallbackFailedError(
                _failure_location(login.return_to, "blocked"), "account_blocked"
            ) from None
        if exc.status_code == 503:
            raise _CallbackFailedError(
                _failure_location(login.return_to, "unavailable"), "store_unavailable"
            ) from None
        raise


@router.get(
    "/telegram/oidc/callback",
    status_code=303,
    response_class=RedirectResponse,
    responses={303: {"description": "Back to the app (signed in) or to its sign-in page"}},
    dependencies=[Depends(login_rate_limit)],
)
async def finish_oidc_login(
    request: Request,
    *,
    oidc: OidcClientDep,
    states: OidcStateStoreDep,
    users: UserRepositoryDep,
    manager: SessionManagerDep,
    code: Annotated[str | None, Query(max_length=1024)] = None,
    state: Annotated[str | None, Query(max_length=64)] = None,
) -> RedirectResponse:
    """Telegram redirects here. Always answers ``303`` to a same-origin path."""
    _clear_binding_cookie(request)
    if state is None or not _STATE_RE.fullmatch(state):
        logger.info("Rejected Telegram OIDC callback: state_malformed")
        return _redirect(_failure_location("/", "failed"))
    try:
        login = await states.take(sha256_hex(state))
    except StoreUnavailableError:
        logger.error("OIDC state store unavailable; failing closed")  # noqa: TRY400
        return _redirect(_failure_location("/", "unavailable"))
    if login is None:
        logger.info("Rejected Telegram OIDC callback: state_unknown")
        return _redirect(_failure_location("/", "failed"))
    try:
        await _complete_oidc_login(request, oidc, login, code, users=users, manager=manager)
    except _CallbackFailedError as failure:
        logger.info("Rejected Telegram OIDC callback: %s", failure.reason)
        return _redirect(failure.location)
    return _redirect(login.return_to)


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
