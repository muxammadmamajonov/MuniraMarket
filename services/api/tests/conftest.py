import os
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api.deps import get_user_repository
from app.core.config import Settings
from app.main import create_app
from app.models.enums import Language, UserRole
from app.repositories.users import TelegramProfile, UserRecord, language_from_code
from app.security.service_auth import InMemoryNonceStore

# Obviously fake values that are only ever used inside the test process.
TEST_SECRET = "test-only-secret-not-for-production-0001"
TEST_KEY_ID = "test-key"
TEST_BOT_ID = 7654321
NOW = 1_767_225_600.0  # 2026-01-01T00:00:00Z, also the ADR 0003 test-vector timestamp


class FakeClock:
    def __init__(self, now: float = NOW) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "test",
        "database_url": "postgresql+asyncpg://fake:fake-password@127.0.0.1:1/fake",
        "redis_url": "redis://localhost:6379/0",
        "cors_allowed_origins": [],
        "service_auth_keys": f"{TEST_KEY_ID}:{TEST_SECRET}",
        "telegram_bot_id": TEST_BOT_ID,
        "telegram_environment": "test",
        # Required in staging/production; harmless elsewhere. A private (RFC 1918) address.
        "forwarded_allow_ips": "10.20.0.2",
    }
    if overrides.get("app_env") in ("staging", "production"):
        # Deployed environments require TLS to PostgreSQL and Redis and trusted origins; tests
        # that exercise those rules override these again.
        values.update(
            database_url="postgresql+asyncpg://fake:fake-password@127.0.0.1:1/fake?ssl=require",
            redis_url="rediss://localhost:6379/0",
            csrf_trusted_origins="https://shop.example.test,https://admin.example.test",
            telegram_environment="production",
        )
    values.update(overrides)
    # model_validate bypasses the process environment and any local .env file.
    return Settings.model_validate(values)


class FakeUserRepository:
    """In-memory stand-in for the SQLAlchemy repository."""

    def __init__(self) -> None:
        self.users: dict[int, UserRecord] = {}
        self.upserts: list[TelegramProfile] = []

    async def upsert_from_telegram(self, profile: TelegramProfile) -> UserRecord:
        self.upserts.append(profile)
        existing = self.users.get(profile.telegram_user_id)
        record = UserRecord(
            id=existing.id if existing else uuid.uuid4(),
            telegram_user_id=profile.telegram_user_id,
            first_name=profile.first_name,
            last_name=profile.last_name,
            username=profile.username,
            language=(
                existing.language
                if existing
                else (language_from_code(profile.language_code) or Language.UZ)
            ),
            role=existing.role if existing else UserRole.CUSTOMER,
            is_blocked=existing.is_blocked if existing else False,
        )
        self.users[profile.telegram_user_id] = record
        return record

    async def get_by_telegram_id(self, telegram_user_id: int) -> UserRecord | None:
        return self.users.get(telegram_user_id)

    async def get_by_id(self, user_id: uuid.UUID) -> UserRecord | None:
        return next((user for user in self.users.values() if user.id == user_id), None)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def users() -> FakeUserRepository:
    return FakeUserRepository()


@pytest.fixture
def app(clock: FakeClock, users: FakeUserRepository) -> FastAPI:
    application = create_app(make_settings(), clock=clock, nonce_store=InMemoryNonceStore(clock))
    application.dependency_overrides[get_user_repository] = lambda: users
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "redis: requires a real Redis (set TEST_REDIS_URL); skipped otherwise"
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    skip_db = pytest.mark.skip(reason="integration test: set TEST_DATABASE_URL to run")
    skip_redis = pytest.mark.skip(reason="integration test: set TEST_REDIS_URL to run")
    has_db = bool(os.environ.get("TEST_DATABASE_URL"))
    has_redis = bool(os.environ.get("TEST_REDIS_URL"))
    for item in items:
        if item.get_closest_marker("redis") is not None:
            if not has_redis:
                item.add_marker(skip_redis)
        elif item.get_closest_marker("integration") is not None and not has_db:
            item.add_marker(skip_db)


SettingsFactory = Callable[..., Settings]
