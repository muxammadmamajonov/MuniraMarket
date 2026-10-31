"""CSRF: Origin/Referer check and the session-bound synchronizer token."""

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api.auth_deps import CsrfProtectedUserDep
from app.core.config import AppEnv
from app.security.csrf import CsrfError, check_origin, check_token
from app.security.rate_limit import InMemoryRateLimiter
from app.security.session import InMemorySessionStore
from tests.auth_helpers import (
    INIT_DATA_PATH,
    TRUSTED_ORIGIN,
    build_app,
    cookie_header,
    http_client,
    init_data,
    login,
)
from tests.conftest import FakeClock, FakeUserRepository

WRITE_PATH = "/api/v1/test/write"
TRUSTED = [TRUSTED_ORIGIN, "http://localhost:3000"]


# --- unit ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://shop.example"},
        {"origin": "HTTPS://Shop.Example:443"},
        {"origin": "http://localhost:3000"},
        {"referer": "https://shop.example/cart?x=1"},
    ],
)
@pytest.mark.parametrize("app_env", ["development", "test", "staging", "production"])
def test_trusted_origins_pass(headers: dict[str, str], app_env: AppEnv) -> None:
    check_origin(headers, trusted_origins=TRUSTED, app_env=app_env)


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example"},
        {"origin": "https://shop.example.evil.example"},
        {"origin": "http://shop.example"},  # scheme matters
        {"origin": "https://shop.example:8443"},  # port matters
        {"origin": "null"},
        {"origin": ""},
        {"origin": "garbage"},
        {"referer": "https://evil.example/page"},
        # Origin wins over a trusted Referer.
        {"origin": "https://evil.example", "referer": "https://shop.example/"},
    ],
)
@pytest.mark.parametrize("app_env", ["development", "test", "staging", "production"])
def test_untrusted_origins_fail(headers: dict[str, str], app_env: AppEnv) -> None:
    with pytest.raises(CsrfError):
        check_origin(headers, trusted_origins=TRUSTED, app_env=app_env)


@pytest.mark.parametrize(("app_env", "allowed"), [("development", True), ("test", True)])
def test_absent_origin_allowed_in_development(app_env: AppEnv, allowed: bool) -> None:
    check_origin({}, trusted_origins=TRUSTED, app_env=app_env)


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_absent_origin_rejected_when_deployed(app_env: AppEnv) -> None:
    with pytest.raises(CsrfError, match="origin_missing"):
        check_origin({}, trusted_origins=TRUSTED, app_env=app_env)


def test_token_comparison() -> None:
    check_token("abc", "abc")
    for received in (None, "", "abd", "abc ", "ABC"):
        with pytest.raises(CsrfError):
            check_token("abc", received)


# --- through the dependency --------------------------------------------------------------------


def _with_write_route(app: FastAPI) -> FastAPI:
    async def write(user: CsrfProtectedUserDep) -> dict[str, str]:
        return {"user_id": str(user.id)}

    async def read(user: CsrfProtectedUserDep) -> dict[str, str]:
        return {"user_id": str(user.id)}

    app.add_api_route(WRITE_PATH, write, methods=["POST", "PUT", "PATCH", "DELETE"])
    app.add_api_route(WRITE_PATH, read, methods=["GET"])
    return app


@pytest.fixture
async def api(clock: FakeClock, users: FakeUserRepository) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(_with_write_route(build_app(clock, users))) as http:
        yield http


async def _signed_in(api: httpx.AsyncClient, clock: FakeClock) -> tuple[dict[str, str], str]:
    session = await login(api, clock)
    return cookie_header(session.token), session.csrf_token


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
async def test_valid_token_passes(api: httpx.AsyncClient, clock: FakeClock, method: str) -> None:
    cookie, csrf = await _signed_in(api, clock)
    response = await api.request(
        method, WRITE_PATH, headers={**cookie, "X-CSRF-Token": csrf, "Origin": TRUSTED_ORIGIN}
    )
    assert response.status_code == 200


async def test_safe_methods_need_no_token(api: httpx.AsyncClient, clock: FakeClock) -> None:
    cookie, _ = await _signed_in(api, clock)
    response = await api.get(WRITE_PATH, headers={**cookie, "Origin": "https://evil.example"})
    assert response.status_code == 200


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"X-CSRF-Token": ""},
        {"X-CSRF-Token": "wrong"},
        {"X-CSRF-Token": "<csrf>", "Origin": "https://evil.example"},
        {"X-CSRF-Token": "<csrf>", "Origin": "null"},
        {"X-CSRF-Token": "<csrf>", "Referer": "https://evil.example/x"},
    ],
)
async def test_csrf_failures(
    api: httpx.AsyncClient, clock: FakeClock, extra: dict[str, str]
) -> None:
    cookie, csrf = await _signed_in(api, clock)
    headers = {**cookie, **{k: v.replace("<csrf>", csrf) for k, v in extra.items()}}
    response = await api.post(WRITE_PATH, headers=headers)
    assert response.status_code == 403
    assert response.json() == {
        "error": {"code": "csrf_failed", "message": "CSRF validation failed"}
    }
    assert csrf not in response.text


async def test_token_of_another_session_fails(api: httpx.AsyncClient, clock: FakeClock) -> None:
    cookie, _ = await _signed_in(api, clock)
    _, other_csrf = await _signed_in(api, clock)
    response = await api.post(WRITE_PATH, headers={**cookie, "X-CSRF-Token": other_csrf})
    assert response.status_code == 403


async def test_no_session_is_401_before_csrf(api: httpx.AsyncClient) -> None:
    response = await api.post(WRITE_PATH, headers={"X-CSRF-Token": "x"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session_required"


async def test_login_enforces_origin(api: httpx.AsyncClient, clock: FakeClock) -> None:
    body = {"init_data": init_data(clock)}
    evil = await api.post(INIT_DATA_PATH, json=body, headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    assert evil.json()["error"]["code"] == "csrf_failed"
    good = await api.post(INIT_DATA_PATH, json=body, headers={"Origin": TRUSTED_ORIGIN})
    assert good.status_code == 200


# --- deployed environments ---------------------------------------------------------------------


def _staging_settings() -> dict[str, Any]:
    return {"app_env": "staging", "telegram_environment": "production"}


async def test_staging_rejects_requests_without_origin_or_referer(
    clock: FakeClock, users: FakeUserRepository
) -> None:
    # In-memory stores: staging requires a TLS Redis URL, and this test is about CSRF only.
    app = _with_write_route(
        build_app(
            clock,
            users,
            session_store=InMemorySessionStore(clock),
            rate_limiter=InMemoryRateLimiter(clock),
            **_staging_settings(),
        )
    )
    async with http_client(app) as http:
        body = {"init_data": init_data(clock)}
        bare = await http.post(INIT_DATA_PATH, json=body)
        assert bare.status_code == 403
        assert bare.json()["error"]["code"] == "csrf_failed"

        session = await login(http, clock, headers={"Origin": TRUSTED_ORIGIN})
        headers = {**cookie_header(session.token), "X-CSRF-Token": session.csrf_token}
        assert (await http.post(WRITE_PATH, headers=headers)).status_code == 403
        with_referer = {**headers, "Referer": f"{TRUSTED_ORIGIN}/cart"}
        assert (await http.post(WRITE_PATH, headers=with_referer)).status_code == 200
        with_origin = {**headers, "Origin": TRUSTED_ORIGIN}
        assert (await http.post(WRITE_PATH, headers=with_origin)).status_code == 200


async def test_development_allows_requests_without_origin(
    clock: FakeClock, users: FakeUserRepository
) -> None:
    app = _with_write_route(build_app(clock, users, app_env="development"))
    async with http_client(app) as http:
        session = await login(http, clock)
        headers = {**cookie_header(session.token), "X-CSRF-Token": session.csrf_token}
        assert (await http.post(WRITE_PATH, headers=headers)).status_code == 200
