"""Fixed-window rate limiting: per IP, per user, Retry-After, Redis command shape."""

import os
import uuid
from collections.abc import AsyncIterator
from typing import Annotated, cast

import httpx
import pytest
from fastapi import Depends, FastAPI
from redis.asyncio import Redis

from app.api.auth_deps import get_current_user, get_rate_limiter, rate_limit
from app.models.enums import Language, UserRole
from app.repositories.users import UserRecord
from app.security.rate_limit import (
    AUTH_LOGIN,
    InMemoryRateLimiter,
    RateLimitDecision,
    RedisRateLimiter,
)
from app.security.session import StoreUnavailableError
from tests.auth_helpers import (
    INIT_DATA_PATH,
    SESSION_PATH,
    FakeRedis,
    build_app,
    http_client,
    init_data,
)
from tests.conftest import NOW, FakeClock, FakeUserRepository

USER_PATH = "/api/v1/test/limited"


def _user(telegram_user_id: int) -> UserRecord:
    return UserRecord(
        id=uuid.uuid4(),
        telegram_user_id=telegram_user_id,
        first_name="Test",
        last_name=None,
        username=None,
        language=Language.UZ,
        role=UserRole.CUSTOMER,
        is_blocked=False,
    )


# --- limiter unit tests ------------------------------------------------------------------------


async def test_in_memory_fixed_window(clock: FakeClock) -> None:
    limiter = InMemoryRateLimiter(clock)
    clock.now = NOW + 15  # NOW is aligned to a minute boundary
    for _ in range(3):
        assert (await limiter.hit("s", "a", limit=3, window_seconds=60)).allowed
    blocked = await limiter.hit("s", "a", limit=3, window_seconds=60)
    assert not blocked.allowed
    assert blocked.retry_after_seconds == 45
    assert (await limiter.hit("s", "b", limit=3, window_seconds=60)).allowed  # other subject
    assert (await limiter.hit("t", "a", limit=3, window_seconds=60)).allowed  # other scope
    clock.now = NOW + 60
    assert (await limiter.hit("s", "a", limit=3, window_seconds=60)).allowed


async def test_redis_limiter_commands(clock: FakeClock) -> None:
    fake = FakeRedis()
    limiter = RedisRateLimiter(cast("Redis", fake), clock)
    clock.now = NOW + 59.5
    first = await limiter.hit("auth_login", "203.0.113.7", limit=1, window_seconds=60)
    key = f"mm:rl:auth_login:203.0.113.7:{int(NOW)}"
    assert fake.commands == [
        ("MULTI",),
        ("INCR", key),
        ("EXPIRE", key, 60, "NX"),
        ("EXEC",),
    ]
    assert fake.ttls[key] == 60
    second = await limiter.hit("auth_login", "203.0.113.7", limit=1, window_seconds=60)
    assert first.allowed
    assert not second.allowed
    assert second.retry_after_seconds == 1  # never 0


async def test_redis_limiter_fails_closed(clock: FakeClock) -> None:
    limiter = RedisRateLimiter(cast("Redis", FakeRedis(fail=True)), clock)
    with pytest.raises(StoreUnavailableError):
        await limiter.hit("s", "a", limit=1, window_seconds=60)


def test_rate_limit_rejects_bad_arguments() -> None:
    for args in (("Bad Scope", 1, 60), ("ok", 0, 60), ("ok", 1, 0), ("", 1, 1)):
        with pytest.raises(ValueError, match="rate_limit"):
            rate_limit(*args)


# --- per IP (login) ----------------------------------------------------------------------------


@pytest.fixture
def app(clock: FakeClock, users: FakeUserRepository) -> FastAPI:
    application = build_app(clock, users)

    async def limited(
        user: Annotated[UserRecord, Depends(get_current_user)],
        _: Annotated[None, Depends(rate_limit("test_user", 2, 60, key="user"))],
    ) -> dict[str, int]:
        return {"telegram_user_id": user.telegram_user_id}

    application.add_api_route(USER_PATH, limited, methods=["GET"])
    return application


@pytest.fixture
async def api(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as http:
        yield http


async def test_login_is_limited_per_ip(api: httpx.AsyncClient, clock: FakeClock) -> None:
    clock.now = NOW + 20
    body = {"init_data": init_data(clock)}
    for _ in range(AUTH_LOGIN.limit):
        assert (await api.post(INIT_DATA_PATH, json=body)).status_code == 200
    limited = await api.post(INIT_DATA_PATH, json=body)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert limited.headers["retry-after"] == "40"
    # Invalid attempts count too, and are rejected before verification.
    assert (await api.post(INIT_DATA_PATH, json={"init_data": "x"})).status_code == 429

    clock.now = NOW + 60
    assert (await api.post(INIT_DATA_PATH, json=body)).status_code == 200


async def test_session_lookups_are_limited_per_ip(api: httpx.AsyncClient) -> None:
    for _ in range(60):
        assert (await api.get(SESSION_PATH)).status_code == 401
    response = await api.get(SESSION_PATH)
    assert response.status_code == 429
    assert "retry-after" in response.headers


async def test_limits_are_per_client_ip(clock: FakeClock, users: FakeUserRepository) -> None:
    app = build_app(clock, users)
    body = {"init_data": init_data(clock)}
    for host in ("198.51.100.1", "198.51.100.2"):
        transport = httpx.ASGITransport(app=app, client=(host, 1234))
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as http:
            statuses = [
                (await http.post(INIT_DATA_PATH, json=body)).status_code
                for _ in range(AUTH_LOGIN.limit + 1)
            ]
        assert statuses == [200] * AUTH_LOGIN.limit + [429]


# --- per user ----------------------------------------------------------------------------------


async def test_user_scoped_limit(app: FastAPI, api: httpx.AsyncClient) -> None:
    alice, bob = _user(1), _user(2)
    current = {"user": alice}
    app.dependency_overrides[get_current_user] = lambda: current["user"]

    assert [(await api.get(USER_PATH)).status_code for _ in range(3)] == [200, 200, 429]
    current["user"] = bob
    assert (await api.get(USER_PATH)).status_code == 200


async def test_user_scoped_limit_requires_a_session(api: httpx.AsyncClient) -> None:
    response = await api.get(USER_PATH)
    assert response.status_code == 401


async def test_limiter_can_be_overridden(app: FastAPI, api: httpx.AsyncClient) -> None:
    class AlwaysAllow:
        async def hit(
            self, scope: str, subject: str, *, limit: int, window_seconds: int
        ) -> RateLimitDecision:
            return RateLimitDecision(allowed=True, retry_after_seconds=1)

    app.dependency_overrides[get_rate_limiter] = AlwaysAllow
    app.dependency_overrides[get_current_user] = lambda: _user(3)
    assert {(await api.get(USER_PATH)).status_code for _ in range(5)} == {200}


# --- optional: real Redis -------------------------------------------------------------------


@pytest.fixture
async def real_redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(os.environ["TEST_REDIS_URL"], decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.mark.integration
@pytest.mark.redis
async def test_real_redis_fixed_window(real_redis: Redis, clock: FakeClock) -> None:
    limiter = RedisRateLimiter(real_redis, clock)
    scope = f"test_{uuid.uuid4().hex}"
    key = f"mm:rl:{scope}:a:{int(NOW)}"
    try:
        decisions = [
            (await limiter.hit(scope, "a", limit=2, window_seconds=60)).allowed for _ in range(3)
        ]
        assert decisions == [True, True, False]
        assert 0 < await real_redis.ttl(key) <= 60
    finally:
        await real_redis.delete(key)
