"""Application factory. Run with ``uvicorn app.main:create_app --factory``."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from app import __version__
from app.api.router import api_router
from app.core.body_limit import DEFAULT_MAX_BODY_BYTES, BodySizeLimitMiddleware
from app.core.clock import Clock, system_clock
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.db.session import create_engine, create_session_factory
from app.security.cookies import SessionCookieMiddleware
from app.security.rate_limit import InMemoryRateLimiter, RateLimiter, RedisRateLimiter
from app.security.service_auth import (
    InMemoryNonceStore,
    NonceStore,
    RedisNonceStore,
    ServiceAuthenticator,
)
from app.security.session import (
    InMemorySessionStore,
    RedisSessionStore,
    SessionManager,
    SessionStore,
)
from app.telegram.identity import (
    TELEGRAM_PUBLIC_KEYS,
    Ed25519InitDataVerifier,
    HmacInitDataVerifier,
    TelegramIdentityVerifier,
)
from app.telegram.login_widget import LoginWidgetVerifier

API_PREFIX = "/api/v1"
# initData is capped at 4096 characters; leave room for JSON framing and URL-encoding overhead.
INIT_DATA_MAX_BODY_BYTES = 8 * 1024
# Login Widget payloads are a handful of short fields (the photo URL is the longest).
LOGIN_WIDGET_MAX_BODY_BYTES = 4 * 1024


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


def build_login_widget_verifier(settings: Settings, clock: Clock) -> LoginWidgetVerifier | None:
    """``None`` unless the Login Widget is enabled (the settings validator guarantees a token)."""
    if not settings.telegram_login_widget_enabled or settings.telegram_bot_token is None:
        return None
    return LoginWidgetVerifier(
        bot_token=settings.telegram_bot_token.get_secret_value(),
        max_age_seconds=settings.telegram_login_max_age_seconds,
        clock=clock,
    )


def create_app(
    settings: Settings | None = None,
    *,
    clock: Clock = system_clock,
    nonce_store: NonceStore | None = None,
    session_store: SessionStore | None = None,
    rate_limiter: RateLimiter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO)

    engine = create_engine(settings)
    in_memory = settings.app_env == "test"
    # One Redis client (connection pool) shared by every Redis-backed store, created only if
    # some store actually needs it.
    redis_client: Redis | None = None

    def redis() -> Redis:
        nonlocal redis_client
        if redis_client is None:
            redis_client = Redis.from_url(
                settings.redis_url.get_secret_value(), decode_responses=True
            )
        return redis_client

    if nonce_store is None:
        nonce_store = InMemoryNonceStore(clock) if in_memory else RedisNonceStore(redis())
    if session_store is None:
        session_store = InMemorySessionStore(clock) if in_memory else RedisSessionStore(redis())
    if rate_limiter is None:
        rate_limiter = InMemoryRateLimiter(clock) if in_memory else RedisRateLimiter(redis(), clock)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if redis_client is not None:
                await redis_client.aclose()
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
    app.state.session_factory = create_session_factory(engine)
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
    app.state.login_widget_verifier = build_login_widget_verifier(settings, clock)

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
            f"{API_PREFIX}/auth/telegram/login-widget": LOGIN_WIDGET_MAX_BODY_BYTES,
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

    register_exception_handlers(app)
    app.include_router(api_router)
    return app
