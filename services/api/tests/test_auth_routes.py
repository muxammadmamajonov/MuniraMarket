"""Auth routes end to end: cookies, session lookup, expiry, rotation, logout, blocking."""

import dataclasses
from collections.abc import AsyncIterator
from typing import cast

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis

from app.api.auth_deps import CsrfProtectedUserDep
from app.security.rate_limit import InMemoryRateLimiter, RedisRateLimiter
from app.security.session import (
    InMemorySessionStore,
    RedisSessionStore,
    SessionData,
    hash_token,
)
from tests.auth_helpers import (
    CONFIG_PATH,
    INIT_DATA_PATH,
    LOGOUT_PATH,
    PLAIN_COOKIE,
    SECURE_COOKIE,
    SESSION_PATH,
    TELEGRAM_USER_ID,
    FakeRedis,
    build_app,
    cookie_header,
    http_client,
    init_data,
    login,
    only_cookie,
    set_cookies,
)
from tests.conftest import NOW, FakeClock, FakeUserRepository

DAY = 86400
WRITE_PATH = "/api/v1/test/write"


@pytest.fixture
def store(clock: FakeClock) -> InMemorySessionStore:
    return InMemorySessionStore(clock)


@pytest.fixture
def auth_app(clock: FakeClock, users: FakeUserRepository, store: InMemorySessionStore) -> FastAPI:
    app = build_app(clock, users, session_store=store)

    async def write(user: CsrfProtectedUserDep) -> dict[str, str]:
        return {"user_id": str(user.id)}

    app.add_api_route(WRITE_PATH, write, methods=["POST"])
    return app


@pytest.fixture
async def api(auth_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(auth_app) as http:
        yield http


def _block(users: FakeUserRepository, telegram_user_id: int = TELEGRAM_USER_ID) -> None:
    users.users[telegram_user_id] = dataclasses.replace(
        users.users[telegram_user_id], is_blocked=True
    )


# --- login ------------------------------------------------------------------------------------


async def test_login_sets_secure_host_cookie(
    api: httpx.AsyncClient, clock: FakeClock, store: InMemorySessionStore
) -> None:
    session = await login(api, clock)
    response = session.response
    cookie = only_cookie(response)
    assert cookie.name == SECURE_COOKIE
    assert cookie.attributes == {
        "max-age": str(30 * DAY),
        "path": "/",
        "httponly": "",
        "samesite": "Lax",
        "secure": "",
    }
    assert "domain" not in cookie.attributes
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"user", "csrf_token"}
    assert body["user"]["telegram_user_id"] == TELEGRAM_USER_ID
    assert len(store) == 1
    assert hash_token(session.token) in store._records
    assert session.token not in response.text


async def test_login_cookie_without_secure_in_development(
    clock: FakeClock, users: FakeUserRepository
) -> None:
    app = build_app(clock, users, app_env="development", session_cookie_secure=False)
    async with http_client(app) as http:
        cookie = only_cookie((await login(http, clock)).response)
    assert cookie.name == PLAIN_COOKIE
    assert "secure" not in cookie.attributes
    assert cookie.attributes["httponly"] == ""
    assert cookie.attributes["samesite"] == "Lax"


async def test_invalid_init_data_sets_no_cookie(api: httpx.AsyncClient) -> None:
    response = await api.post(INIT_DATA_PATH, json={"init_data": "auth_date=1&hash=00"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_telegram_auth"
    assert set_cookies(response) == []
    assert response.headers["cache-control"] == "no-store"


async def test_login_replaces_the_presented_session(
    api: httpx.AsyncClient, clock: FakeClock, store: InMemorySessionStore
) -> None:
    first = await login(api, clock)
    second = await login(api, clock, headers=cookie_header(first.token))
    assert second.token != first.token
    assert second.csrf_token != first.csrf_token
    assert len(store) == 1
    assert (await api.get(SESSION_PATH, headers=cookie_header(first.token))).status_code == 401
    assert (await api.get(SESSION_PATH, headers=cookie_header(second.token))).status_code == 200


async def test_login_as_another_user_drops_the_old_session(
    api: httpx.AsyncClient, clock: FakeClock, store: InMemorySessionStore
) -> None:
    first = await login(api, clock)
    await login(api, clock, telegram_user_id=555, headers=cookie_header(first.token))
    assert len(store) == 1
    assert (await api.get(SESSION_PATH, headers=cookie_header(first.token))).status_code == 401


async def test_blocked_user_cannot_log_in(
    api: httpx.AsyncClient, clock: FakeClock, users: FakeUserRepository
) -> None:
    previous = await login(api, clock)
    _block(users)
    response = await api.post(
        INIT_DATA_PATH,
        json={"init_data": init_data(clock)},
        headers=cookie_header(previous.token),
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "account_blocked"
    assert only_cookie(response).attributes["max-age"] == "0"
    lookup = await api.get(SESSION_PATH, headers=cookie_header(previous.token))
    assert lookup.status_code == 401


# --- GET /auth/session ---------------------------------------------------------------------------


async def test_session_lookup(api: httpx.AsyncClient, clock: FakeClock) -> None:
    session = await login(api, clock)
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 200
    assert response.json()["csrf_token"] == session.csrf_token
    assert response.json()["user"]["telegram_user_id"] == TELEGRAM_USER_ID
    assert response.headers["cache-control"] == "no-store"
    assert set_cookies(response) == []  # no rotation yet


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Cookie": f"{SECURE_COOKIE}=not-a-token"},
        {"Cookie": f"{SECURE_COOKIE}={'A' * 43}"},
        {"Cookie": f"{PLAIN_COOKIE}={'A' * 43}"},  # the secure deployment ignores this name
    ],
)
async def test_session_required(api: httpx.AsyncClient, headers: dict[str, str]) -> None:
    response = await api.get(SESSION_PATH, headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session_required"
    assert response.headers["cache-control"] == "no-store"


async def test_unknown_session_cookie_is_cleared(api: httpx.AsyncClient) -> None:
    response = await api.get(SESSION_PATH, headers=cookie_header("A" * 43))
    assert response.status_code == 401
    cookie = only_cookie(response)
    assert cookie.name == SECURE_COOKIE
    assert cookie.attributes["max-age"] == "0"


async def test_sliding_idle_expiry(api: httpx.AsyncClient, clock: FakeClock) -> None:
    session = await login(api, clock)
    for _ in range(3):
        clock.now += 6 * DAY
        response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
        assert response.status_code == 200
        rotated = set_cookies(response)
        if rotated:  # rotation after 24 h hands out a new token
            session = dataclasses.replace(session, token=rotated[0].value)
    clock.now += 7 * DAY + 1
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 401


async def test_absolute_expiry(api: httpx.AsyncClient, clock: FakeClock) -> None:
    session = await login(api, clock)
    token = session.token
    while clock.now + 6 * DAY < NOW + 30 * DAY:
        clock.now += 6 * DAY
        response = await api.get(SESSION_PATH, headers=cookie_header(token))
        assert response.status_code == 200
        if cookies := set_cookies(response):
            token = cookies[0].value
            assert int(cookies[0].attributes["max-age"]) == NOW + 30 * DAY - clock.now
    clock.now = NOW + 30 * DAY
    assert (await api.get(SESSION_PATH, headers=cookie_header(token))).status_code == 401


async def test_rotation_after_threshold(api: httpx.AsyncClient, clock: FakeClock) -> None:
    session = await login(api, clock)
    clock.now += DAY - 1
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert set_cookies(response) == []

    clock.now += 1
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 200
    cookie = only_cookie(response)
    assert cookie.name == SECURE_COOKIE
    assert cookie.value != session.token
    assert cookie.attributes["max-age"] == str(29 * DAY)
    assert response.json()["csrf_token"] == session.csrf_token  # CSRF token is kept

    old = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert old.status_code == 401
    new = await api.get(SESSION_PATH, headers=cookie_header(cookie.value))
    assert new.status_code == 200
    assert set_cookies(new) == []


async def test_rotated_cookie_survives_a_failing_route(
    api: httpx.AsyncClient, clock: FakeClock
) -> None:
    session = await login(api, clock)
    clock.now += DAY
    response = await api.post(
        WRITE_PATH, headers={**cookie_header(session.token), "X-CSRF-Token": "wrong"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"
    rotated = only_cookie(response)
    assert rotated.value != session.token
    assert response.headers["cache-control"] == "no-store"
    ok = await api.post(
        WRITE_PATH,
        headers={**cookie_header(rotated.value), "X-CSRF-Token": session.csrf_token},
    )
    assert ok.status_code == 200


class _LogoutDuringRotationStore(InMemorySessionStore):
    """Deletes the old session just before the swap, like a concurrent logout or block."""

    async def replace(
        self, old_hash: str, new_hash: str, data: SessionData, ttl_seconds: int
    ) -> bool:
        await self.delete(old_hash)
        return await super().replace(old_hash, new_hash, data, ttl_seconds)


async def test_concurrent_logout_during_rotation_is_401(
    clock: FakeClock, users: FakeUserRepository
) -> None:
    store = _LogoutDuringRotationStore(clock)
    async with http_client(build_app(clock, users, session_store=store)) as http:
        session = await login(http, clock)
        clock.now += DAY
        response = await http.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session_required"
    assert set_cookies(response) == []
    assert len(store) == 0  # the revoked session was not resurrected under a new token


async def test_blocked_user_is_rejected_and_session_deleted(
    api: httpx.AsyncClient,
    clock: FakeClock,
    users: FakeUserRepository,
    store: InMemorySessionStore,
) -> None:
    session = await login(api, clock)
    _block(users)
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "account_blocked"
    assert only_cookie(response).attributes["max-age"] == "0"
    assert len(store) == 0

    users.users[TELEGRAM_USER_ID] = dataclasses.replace(
        users.users[TELEGRAM_USER_ID], is_blocked=False
    )
    again = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert again.status_code == 401  # unblocking does not resurrect the session


async def test_deleted_user_session_is_rejected(
    api: httpx.AsyncClient, clock: FakeClock, users: FakeUserRepository
) -> None:
    session = await login(api, clock)
    users.users.clear()
    response = await api.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 401


# --- logout ----------------------------------------------------------------------------------


async def test_logout_deletes_session_and_clears_cookie(
    api: httpx.AsyncClient, clock: FakeClock, store: InMemorySessionStore
) -> None:
    session = await login(api, clock)
    response = await api.post(
        LOGOUT_PATH,
        headers={**cookie_header(session.token), "X-CSRF-Token": session.csrf_token},
    )
    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    cookie = only_cookie(response)
    assert cookie.name == SECURE_COOKIE
    assert cookie.attributes["max-age"] == "0"
    assert {"path", "httponly", "samesite", "secure"} <= cookie.attributes.keys()
    assert len(store) == 0
    assert (await api.get(SESSION_PATH, headers=cookie_header(session.token))).status_code == 401


@pytest.mark.parametrize("csrf", [None, "wrong"])
async def test_logout_with_session_requires_csrf_token(
    api: httpx.AsyncClient, clock: FakeClock, store: InMemorySessionStore, csrf: str | None
) -> None:
    session = await login(api, clock)
    headers = cookie_header(session.token)
    if csrf is not None:
        headers["X-CSRF-Token"] = csrf
    response = await api.post(LOGOUT_PATH, headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"
    assert len(store) == 1


async def test_logout_without_session_is_idempotent(api: httpx.AsyncClient) -> None:
    for headers in ({}, cookie_header("A" * 43)):
        response = await api.post(LOGOUT_PATH, headers=headers)
        assert response.status_code == 204
        assert only_cookie(response).attributes["max-age"] == "0"


async def test_logout_rejects_untrusted_origin(api: httpx.AsyncClient) -> None:
    response = await api.post(LOGOUT_PATH, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


# --- config ------------------------------------------------------------------------------------


async def test_auth_config_defaults_to_widget_disabled(api: httpx.AsyncClient) -> None:
    response = await api.get(CONFIG_PATH)
    assert response.status_code == 200
    assert response.json() == {"telegram_login_widget": {"enabled": False, "bot_username": None}}
    assert response.headers["cache-control"] == "no-store"


# --- fail closed on Redis errors ---------------------------------------------------------------


async def test_session_store_outage_is_503(clock: FakeClock, users: FakeUserRepository) -> None:
    app = build_app(
        clock, users, session_store=RedisSessionStore(cast("Redis", FakeRedis(fail=True)))
    )
    async with http_client(app) as http:
        login_response = await http.post(INIT_DATA_PATH, json={"init_data": init_data(clock)})
        lookup = await http.get(SESSION_PATH, headers=cookie_header("A" * 43))
        logout = await http.post(LOGOUT_PATH, headers=cookie_header("A" * 43))
    for response in (login_response, lookup, logout):
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "service_unavailable"
        assert set_cookies(response) == []


async def test_rate_limiter_outage_is_503(clock: FakeClock, users: FakeUserRepository) -> None:
    limiter = RedisRateLimiter(cast("Redis", FakeRedis(fail=True)), clock)
    app = build_app(clock, users, rate_limiter=limiter)
    async with http_client(app) as http:
        response = await http.post(INIT_DATA_PATH, json={"init_data": init_data(clock)})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
    assert users.upserts == []


async def test_redis_backed_app_end_to_end(clock: FakeClock, users: FakeUserRepository) -> None:
    fake = FakeRedis()
    app = build_app(
        clock,
        users,
        session_store=RedisSessionStore(cast("Redis", fake)),
        rate_limiter=RedisRateLimiter(cast("Redis", fake), clock),
    )
    async with http_client(app) as http:
        session = await login(http, clock)
        response = await http.get(SESSION_PATH, headers=cookie_header(session.token))
    assert response.status_code == 200
    assert f"mm:sess:{hash_token(session.token)}" in fake.data
    assert f"mm:rl:auth_login:127.0.0.1:{int(NOW)}" in fake.data
    assert all(session.token not in str(command) for command in fake.commands)


def test_in_memory_defaults_in_test_env(auth_app: FastAPI) -> None:
    assert isinstance(auth_app.state.rate_limiter, InMemoryRateLimiter)
