"""Shared helpers for the session / CSRF / rate-limit tests (not collected by pytest)."""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any

import httpx
from fastapi import FastAPI
from redis.exceptions import ConnectionError as RedisConnectionError

from app.api.deps import get_user_repository
from app.main import create_app
from app.security.rate_limit import RateLimiter
from app.security.service_auth import InMemoryNonceStore
from app.security.session import ROTATE_SESSION_LUA, SessionStore
from tests.conftest import FakeClock, FakeUserRepository, make_settings
from tests.test_identity import FAKE_BOT_TOKEN, _base_fields, _user_json, sign_hmac

INIT_DATA_PATH = "/api/v1/auth/telegram/init-data"
WIDGET_PATH = "/api/v1/auth/telegram/login-widget"
SESSION_PATH = "/api/v1/auth/session"
LOGOUT_PATH = "/api/v1/auth/logout"
CONFIG_PATH = "/api/v1/auth/config"

TRUSTED_ORIGIN = "https://shop.example"
TEST_BOT_USERNAME = "muniramarket_test_bot"
SECURE_COOKIE = "__Host-mm_session"
PLAIN_COOKIE = "mm_session"
TELEGRAM_USER_ID = 123456789


def build_app(
    clock: FakeClock,
    users: FakeUserRepository,
    *,
    session_store: SessionStore | None = None,
    rate_limiter: RateLimiter | None = None,
    **overrides: Any,
) -> FastAPI:
    """App with the HMAC initData verifier (fake bot token) and a trusted origin configured."""
    values: dict[str, Any] = {
        "telegram_bot_token": FAKE_BOT_TOKEN,
        "csrf_trusted_origins": TRUSTED_ORIGIN,
    }
    values.update(overrides)
    app = create_app(
        make_settings(**values),
        clock=clock,
        nonce_store=InMemoryNonceStore(clock),
        session_store=session_store,
        rate_limiter=rate_limiter,
    )
    app.dependency_overrides[get_user_repository] = lambda: users
    return app


@asynccontextmanager
async def http_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """A client whose cookie jar refuses everything: tests pass ``Cookie`` explicitly."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    jar = CookieJar(policy=DefaultCookiePolicy(allowed_domains=[]))
    async with httpx.AsyncClient(
        transport=transport, base_url="https://test", cookies=jar
    ) as client:
        yield client


def init_data(clock: FakeClock, telegram_user_id: int = TELEGRAM_USER_ID) -> str:
    fields = _base_fields(at=clock.now - 10, user=_user_json(id=telegram_user_id))
    return sign_hmac(fields, token=FAKE_BOT_TOKEN)


@dataclass(frozen=True)
class SetCookie:
    name: str
    value: str
    attributes: dict[str, str]  # lower-case attribute name -> value ("" for flags)


def set_cookies(response: httpx.Response) -> list[SetCookie]:
    parsed: list[SetCookie] = []
    for header in response.headers.get_list("set-cookie"):
        first, *rest = (part.strip() for part in header.split(";"))
        name, _, value = first.partition("=")
        attributes: dict[str, str] = {}
        for part in rest:
            key, _, attr_value = part.partition("=")
            attributes[key.lower()] = attr_value
        parsed.append(SetCookie(name=name, value=value, attributes=attributes))
    return parsed


def only_cookie(response: httpx.Response) -> SetCookie:
    cookies = set_cookies(response)
    assert len(cookies) == 1, cookies
    return cookies[0]


def cookie_header(token: str, name: str = SECURE_COOKIE) -> dict[str, str]:
    return {"Cookie": f"{name}={token}"}


@dataclass(frozen=True)
class LoggedIn:
    token: str
    csrf_token: str
    response: httpx.Response


async def login(
    client: httpx.AsyncClient,
    clock: FakeClock,
    *,
    telegram_user_id: int = TELEGRAM_USER_ID,
    headers: dict[str, str] | None = None,
) -> LoggedIn:
    response = await client.post(
        INIT_DATA_PATH,
        json={"init_data": init_data(clock, telegram_user_id)},
        headers=headers or {},
    )
    assert response.status_code == 200, response.text
    cookie = only_cookie(response)
    return LoggedIn(cookie.value, response.json()["csrf_token"], response)


class FakeRedis:
    """Records the commands the Redis-backed stores send; ``fail=True`` simulates an outage."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.commands: list[tuple[Any, ...]] = []
        self.data: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    def _run(self, name: str, *args: Any, **kwargs: Any) -> Any:  # noqa: PLR0911, PLR0912
        if self.fail:
            raise RedisConnectionError("fake outage")
        command: tuple[Any, ...] = (name, *args)
        if "ex" in kwargs:
            command += ("EX", kwargs["ex"])
        if kwargs.get("nx"):
            command += ("NX",)
        self.commands.append(command)
        key: str = args[0] if args else ""
        if name in ("MULTI", "EXEC"):
            return "OK"
        if name == "GET":
            return self.data.get(key)
        if name == "SET":
            self.data[key] = args[1]
            self.ttls[key] = kwargs["ex"]
            return True
        if name == "EXPIRE":
            if key not in self.data or (kwargs.get("nx") and key in self.ttls):
                return False
            self.ttls[key] = args[1]
            return True
        if name == "DEL":
            return sum(1 for k in args if self.data.pop(k, None) is not None)
        if name == "EVAL":
            # Only the session store's rotation script is supported; this mirrors it line by
            # line (the real script runs in the TEST_REDIS_URL integration tests).
            script, _numkeys, old_key, new_key, value, ttl, tombstone, grace = args
            assert script == ROTATE_SESSION_LUA
            current = self.data.get(old_key)
            if current is None:
                return 0
            try:
                record = json.loads(current)
            except ValueError:
                record = None
            if isinstance(record, dict) and record.get("rotated_to") is not None:
                return 2
            self.data[new_key] = value
            self.ttls[new_key] = int(ttl)
            if int(grace) > 0:
                self.data[old_key] = tombstone
                self.ttls[old_key] = int(grace)
            else:
                del self.data[old_key]
                self.ttls.pop(old_key, None)
            return 1
        if name == "INCR":
            self.data[key] = str(int(self.data.get(key, "0")) + 1)
            return int(self.data[key])
        raise AssertionError(name)

    async def get(self, key: str) -> Any:
        return self._run("GET", key)

    async def set(self, key: str, value: str, *, ex: int) -> Any:
        return self._run("SET", key, value, ex=ex)

    async def expire(self, key: str, seconds: int) -> Any:
        return self._run("EXPIRE", key, seconds)

    async def delete(self, *keys: str) -> Any:
        return self._run("DEL", *keys)

    async def eval(self, script: str, numkeys: int, *keys_and_args: str) -> Any:
        return self._run("EVAL", script, numkeys, *keys_and_args)

    def pipeline(self, *, transaction: bool = True) -> "FakePipeline":
        assert transaction, "stores must use MULTI/EXEC transactions"
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        self._queued: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    async def __aenter__(self) -> "FakePipeline":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def _queue(self, name: str, *args: Any, **kwargs: Any) -> "FakePipeline":
        self._queued.append((name, args, kwargs))
        return self

    def set(self, key: str, value: str, *, ex: int) -> "FakePipeline":
        return self._queue("SET", key, value, ex=ex)

    def delete(self, *keys: str) -> "FakePipeline":
        return self._queue("DEL", *keys)

    def incr(self, key: str) -> "FakePipeline":
        return self._queue("INCR", key)

    def expire(self, key: str, seconds: int, *, nx: bool = False) -> "FakePipeline":
        return self._queue("EXPIRE", key, seconds, nx=nx)

    async def execute(self) -> list[Any]:
        self._redis._run("MULTI")
        results = [self._redis._run(n, *a, **kw) for n, a, kw in self._queued]
        self._redis._run("EXEC")
        return results
