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
from app.security.service_auth import (
    InMemoryNonceStore,
    NonceStore,
    RedisNonceStore,
    ServiceAuthenticator,
)
from app.telegram.identity import (
    TELEGRAM_PUBLIC_KEYS,
    Ed25519InitDataVerifier,
    HmacInitDataVerifier,
    TelegramIdentityVerifier,
)

API_PREFIX = "/api/v1"
# initData is capped at 4096 characters; leave room for JSON framing and URL-encoding overhead.
INIT_DATA_MAX_BODY_BYTES = 8 * 1024


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


def create_app(
    settings: Settings | None = None,
    *,
    clock: Clock = system_clock,
    nonce_store: NonceStore | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO)

    engine = create_engine(settings)
    redis_client: Redis | None = None
    if nonce_store is None:
        if settings.app_env == "test":
            nonce_store = InMemoryNonceStore(clock)
        else:
            redis_client = Redis.from_url(
                settings.redis_url.get_secret_value(), decode_responses=True
            )
            nonce_store = RedisNonceStore(redis_client)

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
    app.state.session_factory = create_session_factory(engine)
    app.state.identity_verifier = build_identity_verifier(settings, clock)
    app.state.service_authenticator = ServiceAuthenticator(
        keys=settings.parsed_service_auth_keys,
        nonce_store=nonce_store,
        clock=clock,
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
        path_limits={f"{API_PREFIX}/auth/telegram/init-data": INIT_DATA_MAX_BODY_BYTES},
    )

    register_exception_handlers(app)
    app.include_router(api_router)
    return app
