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
    }
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


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("TEST_DATABASE_URL"):
        return
    skip = pytest.mark.skip(reason="integration test: set TEST_DATABASE_URL to run")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


SettingsFactory = Callable[..., Settings]
