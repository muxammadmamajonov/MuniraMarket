"""Application factory. Run with ``uvicorn app.main:create_app --factory``."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.router import api_router
from app.core.body_limit import DEFAULT_MAX_BODY_BYTES, BodySizeLimitMiddleware
from app.core.clock import Clock, system_clock
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.db.session import create_engine, create_session_factory
from app.security.cookies import SessionCookieMiddleware
from app.security.neon_auth import NeonAuthVerifier
from app.security.oidc_state import InMemoryOidcStateStore, OidcStateStore, PostgresOidcStateStore
from app.security.rate_limit import InMemoryRateLimiter, PostgresRateLimiter, RateLimiter
from app.security.service_auth import (
    InMemoryNonceStore,
    NonceStore,
    PostgresNonceStore,
    ServiceAuthenticator,
)
from app.security.session import (
    InMemorySessionStore,
    PostgresSessionStore,
    SessionManager,
    SessionStore,
)
from app.storage.images import create_image_storage
from app.telegram.identity import (
    TELEGRAM_PUBLIC_KEYS,
    Ed25519InitDataVerifier,
    HmacInitDataVerifier,
    TelegramIdentityVerifier,
)
from app.telegram.oidc import HttpOidcProvider, OidcClient, OidcEndpoints

logger = logging.getLogger("app.main")

API_PREFIX = "/api/v1"
# initData is capped at 4096 characters; leave room for JSON framing and URL-encoding overhead.
INIT_DATA_MAX_BODY_BYTES = 8 * 1024
# The OIDC start request carries only a return path.
OIDC_START_MAX_BODY_BYTES = 2 * 1024
# Catalog CSV import (admin only): the one route allowed a body above the 64 KiB default.
CSV_IMPORT_MAX_BODY_BYTES = 1024 * 1024


def build_identity_verifier(settings: Settings, clock: Clock) -> TelegramIdentityVerifier:
    """Ed25519 (third-party validation) by default; HMAC only if a bot token is configured."""
    max_age = settings.telegram_init_data_max_age_seconds
    if settings.telegram_bot_token is not None:
        return HmacInitDataVerifier(
            bot_token=settings.telegram_bot_token.get_secret_value(),
            max_age_seconds=max_age,
            clock=clock,
        )
    return Ed25519InitDataVerifier(
        bot_id=settings.telegram_bot_id,
        public_key_hex=TELEGRAM_PUBLIC_KEYS[settings.telegram_environment],
        max_age_seconds=max_age,
        clock=clock,
    )


def build_oidc_client(settings: Settings, clock: Clock) -> OidcClient | None:
    """``None`` unless Telegram OIDC sign-in is enabled (settings guarantee the credentials)."""
    if (
        not settings.telegram_oidc_enabled
        or settings.telegram_oidc_client_id is None
        or settings.telegram_oidc_client_secret is None
    ):
        return None
    endpoints = OidcEndpoints(issuer=settings.telegram_oidc_issuer)
    return OidcClient(
        endpoints=endpoints,
        client_id=settings.telegram_oidc_client_id,
        provider=HttpOidcProvider(
            endpoints=endpoints,
            client_id=settings.telegram_oidc_client_id,
            client_secret=settings.telegram_oidc_client_secret.get_secret_value(),
            clock=clock,
        ),
        state_ttl_seconds=settings.telegram_oidc_state_ttl_seconds,
    )


def create_app(
    settings: Settings | None = None,
    *,
    clock: Clock = system_clock,
    nonce_store: NonceStore | None = None,
    session_store: SessionStore | None = None,
    rate_limiter: RateLimiter | None = None,
    oidc_state_store: OidcStateStore | None = None,
    oidc_client: OidcClient | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(
        level=settings.log_level,
        fmt=settings.log_format,
        env=settings.app_env,
        release=settings.app_release,
    )

    engine = create_engine(settings)
    session_factory = create_session_factory(engine)
    # Unit tests (APP_ENV=test) use process-local stores; everywhere else the security state lives
    # in PostgreSQL on the application's own pool (ADR 0013), so every instance shares it.
    in_memory = settings.app_env == "test"
    if nonce_store is None:
        nonce_store = (
            InMemoryNonceStore(clock) if in_memory else PostgresNonceStore(session_factory, clock)
        )
    if session_store is None:
        session_store = (
            InMemorySessionStore(clock)
            if in_memory
            else PostgresSessionStore(session_factory, clock)
        )
    if rate_limiter is None:
        rate_limiter = (
            InMemoryRateLimiter(clock) if in_memory else PostgresRateLimiter(session_factory, clock)
        )
    if oidc_state_store is None:
        oidc_state_store = (
            InMemoryOidcStateStore(clock)
            if in_memory
            else PostgresOidcStateStore(session_factory, clock)
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # Settings were validated when they were loaded; this line only records what started.
        logger.info(
            "core-api starting",
            extra={
                "event": "startup",
                "db_pool_size": settings.db_pool_size,
                "db_max_overflow": settings.db_max_overflow,
            },
        )
        try:
            yield
        finally:
            # Runs after uvicorn has stopped accepting connections and drained in-flight
            # requests (SIGTERM, bounded by --timeout-graceful-shutdown).
            logger.info("core-api stopping", extra={"event": "shutdown"})
            await engine.dispose()

    docs = settings.docs_enabled
    app = FastAPI(
        title="MuniraMarket Core API",
        version=__version__,
        openapi_url=f"{API_PREFIX}/openapi.json" if docs else None,
        docs_url=f"{API_PREFIX}/docs" if docs else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.clock = clock
    app.state.session_factory = session_factory
    app.state.identity_verifier = build_identity_verifier(settings, clock)
    app.state.service_authenticator = ServiceAuthenticator(
        keys=settings.parsed_service_auth_keys,
        nonce_store=nonce_store,
        clock=clock,
    )
    app.state.session_manager = SessionManager(
        store=session_store,
        clock=clock,
        idle_ttl_seconds=settings.session_idle_ttl_seconds,
        absolute_ttl_seconds=settings.session_absolute_ttl_seconds,
        rotate_after_seconds=settings.session_rotate_after_seconds,
        rotation_grace_seconds=settings.session_rotation_grace_seconds,
    )
    app.state.rate_limiter = rate_limiter
    app.state.oidc_state_store = oidc_state_store
    app.state.oidc_client = (
        oidc_client if oidc_client is not None else build_oidc_client(settings, clock)
    )
    app.state.image_storage = create_image_storage(settings)
    app.state.neon_auth_verifier = (
        NeonAuthVerifier(base_url=settings.neon_auth_base_url, jwks_url=settings.neon_auth_jwks_url)
        if settings.neon_auth_base_url and settings.neon_auth_jwks_url
        else None
    )

    if settings.cors_allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Accept", "Accept-Language"],
        )

    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=DEFAULT_MAX_BODY_BYTES,
        path_limits={
            f"{API_PREFIX}/auth/telegram/init-data": INIT_DATA_MAX_BODY_BYTES,
            f"{API_PREFIX}/auth/telegram/oidc/start": OIDC_START_MAX_BODY_BYTES,
            f"{API_PREFIX}/admin/catalog/csv/import": CSV_IMPORT_MAX_BODY_BYTES,
        },
    )
    # Outermost of our middleware: delivers queued session cookies on every response (errors and
    # unhandled exceptions included) and marks session-bound responses no-store.
    app.add_middleware(
        SessionCookieMiddleware,
        no_store_paths=(
            f"{API_PREFIX}/auth",
            f"{API_PREFIX}/cart",
            f"{API_PREFIX}/checkout",
            f"{API_PREFIX}/orders",
            f"{API_PREFIX}/admin",
            f"{API_PREFIX}/internal",
        ),
    )

    # Outermost: every response (errors included) carries X-Request-ID and gets one access-log
    # line.
    app.add_middleware(RequestContextMiddleware, quiet_paths=(f"{API_PREFIX}/health",))

    register_exception_handlers(app)
    app.include_router(api_router)
    return app
