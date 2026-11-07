"""Bot onboarding language, Telegram contact phone and the checkout phone gate."""

import json

import httpx
from fastapi import FastAPI

from app.api import auth_deps
from app.api.routes import me as me_routes
from app.models.enums import Language
from app.repositories.users import TelegramProfile, normalize_contact_phone
from tests.conftest import FakeUserRepository
from tests.test_service_auth import signed_headers

LANGUAGE_PATH = "/api/v1/internal/telegram/language"
PHONE_PATH = "/api/v1/internal/telegram/phone"
ACTOR = 123456789


def _body(payload: dict[str, object]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode()


async def _seed(users: FakeUserRepository) -> None:
    await users.upsert_from_telegram(TelegramProfile(ACTOR, "Aziza", language_code="uz"))


async def test_bot_language_choice_is_saved_and_confirmed(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    await _seed(users)
    assert users.users[ACTOR].language_confirmed is False
    body = _body({"language": "ru"})
    response = await client.put(
        LANGUAGE_PATH,
        content=body,
        headers=signed_headers(method="PUT", path=LANGUAGE_PATH, body=body),
    )
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["language"] == "ru"
    assert user["language_confirmed"] is True
    assert users.users[ACTOR].language == Language.RU


async def test_bot_language_rejects_unknown_language(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    await _seed(users)
    body = _body({"language": "en"})
    response = await client.put(
        LANGUAGE_PATH,
        content=body,
        headers=signed_headers(method="PUT", path=LANGUAGE_PATH, body=body),
    )
    assert response.status_code == 422


async def test_bot_language_requires_signature(client: httpx.AsyncClient) -> None:
    response = await client.put(LANGUAGE_PATH, content=_body({"language": "ru"}))
    assert response.status_code == 401


async def test_own_contact_verifies_phone_without_echoing_it(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    await _seed(users)
    body = _body({"contact_user_id": ACTOR, "phone_number": "998 90 123 45 67"})
    response = await client.post(
        PHONE_PATH, content=body, headers=signed_headers(method="POST", path=PHONE_PATH, body=body)
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["phone_verified"] is True
    assert "phone" not in response.json()["user"]
    assert "998" not in response.text
    assert users.phones[ACTOR] == "+998901234567"


async def test_someone_elses_contact_is_refused(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    await _seed(users)
    body = _body({"contact_user_id": 555, "phone_number": "+998901234567"})
    response = await client.post(
        PHONE_PATH, content=body, headers=signed_headers(method="POST", path=PHONE_PATH, body=body)
    )
    assert response.status_code == 403
    assert users.users[ACTOR].phone_verified is False


def test_contact_phone_normalization() -> None:
    assert normalize_contact_phone("998901234567") == "+998901234567"
    assert normalize_contact_phone("+7 (912) 345-67-89") == "+79123456789"
    assert normalize_contact_phone("12") is None
    assert normalize_contact_phone("+99890+1234567") is None
    assert normalize_contact_phone("0901234567") is None
    assert normalize_contact_phone("tel:998901234567") is None


async def test_shop_profile_saves_the_same_language(
    app: FastAPI, client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    await _seed(users)
    current = users.users[ACTOR]

    async def allow() -> None:
        return None

    app.dependency_overrides[auth_deps.get_current_user] = lambda: current
    app.dependency_overrides[auth_deps.require_csrf] = allow
    app.dependency_overrides[me_routes.PREFERENCES_WRITE_LIMIT] = allow
    response = await client.put("/api/v1/me/language", json={"language": "ru"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["user"]["language_confirmed"] is True
    assert users.users[ACTOR].language == Language.RU
