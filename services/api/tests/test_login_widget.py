"""Telegram Login Widget verification and the feature-flagged sign-in route."""

import hashlib
import hmac
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.telegram.login_widget import InvalidLoginWidgetData, LoginWidgetVerifier
from tests.auth_helpers import (
    CONFIG_PATH,
    SECURE_COOKIE,
    SESSION_PATH,
    TEST_BOT_USERNAME,
    WIDGET_PATH,
    build_app,
    cookie_header,
    http_client,
    only_cookie,
)
from tests.conftest import NOW, FakeClock, FakeUserRepository
from tests.test_identity import FAKE_BOT_TOKEN

MAX_AGE = 86400


def sign_widget(fields: dict[str, Any], token: str = FAKE_BOT_TOKEN) -> dict[str, Any]:
    """Reference implementation of Telegram's widget signature (independent of app code)."""
    check = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hashlib.sha256(token.encode()).digest()
    return {**fields, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()}


def widget_fields(at: float = NOW - 30, **overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "id": 987654321,
        "first_name": "Aziza",
        "last_name": "Karimova",
        "username": "aziza_k",
        "photo_url": "https://t.me/i/userpic/320/fake.jpg",
        "auth_date": int(at),
    }
    fields.update(overrides)
    return {k: v for k, v in fields.items() if v is not None}


def _as_strings(payload: dict[str, Any]) -> dict[str, str]:
    return {k: str(v) for k, v in payload.items()}


@pytest.fixture
def verifier(clock: FakeClock) -> LoginWidgetVerifier:
    return LoginWidgetVerifier(bot_token=FAKE_BOT_TOKEN, max_age_seconds=MAX_AGE, clock=clock)


# --- verifier ----------------------------------------------------------------------------------


def test_valid_payload(verifier: LoginWidgetVerifier) -> None:
    identity = verifier.verify(_as_strings(sign_widget(widget_fields())))
    assert identity.telegram_user_id == 987654321
    assert identity.first_name == "Aziza"
    assert identity.last_name == "Karimova"
    assert identity.username == "aziza_k"
    assert identity.language_code is None
    assert identity.auth_date == int(NOW - 30)


def test_minimal_payload(verifier: LoginWidgetVerifier) -> None:
    fields = widget_fields(last_name=None, username=None, photo_url=None)
    identity = verifier.verify(_as_strings(sign_widget(fields)))
    assert identity.last_name is None
    assert identity.username is None


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda p: {**p, "first_name": "Mallory"}, "hash_mismatch"),
        (lambda p: {**p, "id": "1"}, "hash_mismatch"),
        (lambda p: {k: v for k, v in p.items() if k != "username"}, "hash_mismatch"),
        (lambda p: {**p, "hash": p["hash"].upper()}, "hash_malformed"),
        (lambda p: {**p, "hash": "0" * 64}, "hash_mismatch"),
        (lambda p: {k: v for k, v in p.items() if k != "hash"}, "hash_malformed"),
        (lambda p: {**p, "language_code": "ru"}, "unknown_field"),
    ],
)
def test_tampered_payloads(verifier: LoginWidgetVerifier, mutate: Any, reason: str) -> None:
    payload = mutate(_as_strings(sign_widget(widget_fields())))
    with pytest.raises(InvalidLoginWidgetData) as excinfo:
        verifier.verify(payload)
    assert excinfo.value.reason == reason


def test_wrong_bot_token(verifier: LoginWidgetVerifier) -> None:
    payload = sign_widget(widget_fields(), token="7654321:another-fake-token")
    with pytest.raises(InvalidLoginWidgetData, match="hash_mismatch"):
        verifier.verify(_as_strings(payload))


def test_signed_unknown_field_is_still_rejected(verifier: LoginWidgetVerifier) -> None:
    payload = sign_widget({**widget_fields(), "is_admin": "true"})
    with pytest.raises(InvalidLoginWidgetData, match="unknown_field"):
        verifier.verify(_as_strings(payload))


@pytest.mark.parametrize(
    ("at", "reason"),
    [
        (NOW - MAX_AGE - 1, "expired"),
        (NOW + 61, "auth_date_in_future"),
    ],
)
def test_stale_and_future_auth_date(verifier: LoginWidgetVerifier, at: float, reason: str) -> None:
    with pytest.raises(InvalidLoginWidgetData, match=reason):
        verifier.verify(_as_strings(sign_widget(widget_fields(at=at))))


def test_auth_date_boundaries(verifier: LoginWidgetVerifier) -> None:
    verifier.verify(_as_strings(sign_widget(widget_fields(at=NOW - MAX_AGE))))
    verifier.verify(_as_strings(sign_widget(widget_fields(at=NOW + 60))))


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"auth_date": "soon"}, "auth_date_invalid"),
        ({"id": "0"}, "user_id_invalid"),
        ({"id": "-5"}, "user_id_invalid"),
        ({"first_name": "   "}, "user_first_name_missing"),
    ],
)
def test_signed_but_invalid_values(
    verifier: LoginWidgetVerifier, overrides: dict[str, str], reason: str
) -> None:
    payload = sign_widget({**_as_strings(widget_fields()), **overrides})
    with pytest.raises(InvalidLoginWidgetData, match=reason):
        verifier.verify(payload)


# --- route -------------------------------------------------------------------------------------


@pytest.fixture
def widget_app(clock: FakeClock, users: FakeUserRepository) -> FastAPI:
    return build_app(
        clock,
        users,
        telegram_login_widget_enabled=True,
        telegram_bot_username=TEST_BOT_USERNAME,
    )


@pytest.fixture
async def api(widget_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(widget_app) as http:
        yield http


async def test_widget_login_issues_session(
    api: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    response = await api.post(WIDGET_PATH, json=sign_widget(widget_fields()))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["user"]["telegram_user_id"] == 987654321
    assert body["user"]["language"] == "uz"
    cookie = only_cookie(response)
    assert cookie.name == SECURE_COOKIE
    assert users.users[987654321].username == "aziza_k"

    session = await api.get(SESSION_PATH, headers=cookie_header(cookie.value))
    assert session.status_code == 200
    assert session.json()["csrf_token"] == body["csrf_token"]


async def test_widget_login_rejects_tampering(
    api: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    payload = {**sign_widget(widget_fields()), "first_name": "Mallory"}
    response = await api.post(WIDGET_PATH, json=payload)
    assert response.status_code == 401
    assert response.json() == {
        "error": {"code": "invalid_telegram_auth", "message": "Invalid Telegram login data"}
    }
    assert users.upserts == []


async def test_widget_login_rejects_stale_payload(api: httpx.AsyncClient) -> None:
    response = await api.post(WIDGET_PATH, json=sign_widget(widget_fields(at=NOW - MAX_AGE - 1)))
    assert response.status_code == 401


async def test_widget_login_rejects_unknown_fields(api: httpx.AsyncClient) -> None:
    payload = sign_widget({**widget_fields(), "is_admin": True})
    response = await api.post(WIDGET_PATH, json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_widget_body_is_capped_at_4_kib(api: httpx.AsyncClient) -> None:
    payload = sign_widget(widget_fields(photo_url="https://t.me/" + "x" * 4096))
    response = await api.post(WIDGET_PATH, json=payload)
    assert response.status_code == 413


async def test_widget_login_enforces_origin(api: httpx.AsyncClient) -> None:
    response = await api.post(
        WIDGET_PATH,
        json=sign_widget(widget_fields()),
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_config_reports_enabled_widget(api: httpx.AsyncClient) -> None:
    response = await api.get(CONFIG_PATH)
    assert response.json() == {
        "telegram_login_widget": {"enabled": True, "bot_username": TEST_BOT_USERNAME}
    }


async def test_disabled_widget_is_404(clock: FakeClock, users: FakeUserRepository) -> None:
    app = build_app(clock, users, telegram_bot_username=TEST_BOT_USERNAME)
    async with http_client(app) as http:
        valid = await http.post(WIDGET_PATH, json=sign_widget(widget_fields()))
        garbage = await http.post(WIDGET_PATH, json={"nonsense": True})
        config = await http.get(CONFIG_PATH)
    for response in (valid, garbage):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "feature_disabled"
        assert "set-cookie" not in response.headers
    assert config.json()["telegram_login_widget"] == {"enabled": False, "bot_username": None}
    assert users.upserts == []
