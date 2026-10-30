import httpx
import pytest
from fastapi import FastAPI

from app import __version__
from app.api.deps import get_identity_verifier, get_session
from app.main import build_identity_verifier, create_app
from app.models.enums import Language
from app.security.service_auth import InMemoryNonceStore
from app.telegram.identity import Ed25519InitDataVerifier, HmacInitDataVerifier
from tests.conftest import FakeClock, FakeUserRepository, make_settings
from tests.test_identity import (
    MAX_AGE,
    PUBLIC_KEY_HEX,
    _base_fields,
    _user_json,
    sign_ed25519,
    sign_hmac,
)

INIT_DATA_PATH = "/api/v1/auth/telegram/init-data"


# --- health --------------------------------------------------------------------------------


async def test_health_needs_no_database(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "core-api", "version": __version__}


class _OkSession:
    async def execute(self, statement: object) -> None:
        assert str(statement) == "SELECT 1"


class _BrokenSession:
    async def execute(self, statement: object) -> None:
        raise ConnectionRefusedError("postgresql://user:hunter2@db.internal:5432/prod is down")


async def test_ready_ok(app: FastAPI, client: httpx.AsyncClient) -> None:
    async def session() -> _OkSession:
        return _OkSession()

    app.dependency_overrides[get_session] = session
    response = await client.get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_ready_reports_503_without_leaking_details(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    async def session() -> _BrokenSession:
        return _BrokenSession()

    app.dependency_overrides[get_session] = session
    response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "hunter2" not in response.text


async def test_ready_with_unreachable_database_is_503(client: httpx.AsyncClient) -> None:
    # No override: the fake DATABASE_URL points at a port nothing listens on.
    response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}


# --- error envelope ------------------------------------------------------------------------


async def test_unknown_route_uses_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/nope")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not Found"}}


async def test_wrong_method_uses_envelope(client: httpx.AsyncClient) -> None:
    response = await client.get(INIT_DATA_PATH)
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


async def test_validation_errors_use_envelope_and_do_not_echo_input(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(INIT_DATA_PATH, json={"init_data": "x" * 4097, "extra": "secret"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["details"]
    assert "x" * 50 not in response.text
    assert "secret" not in response.text


async def test_unhandled_exceptions_are_generic(app: FastAPI, client: httpx.AsyncClient) -> None:
    async def boom() -> None:
        raise RuntimeError("database password is hunter2")

    app.add_api_route("/boom", boom)
    response = await client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error"}
    }
    assert "hunter2" not in response.text


# --- OpenAPI / CORS / wiring -----------------------------------------------------------------


async def test_openapi_enabled_in_test_env(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    assert "/api/v1/health" in paths
    assert "/api/v1/internal/telegram/session" in paths


@pytest.mark.parametrize("app_env", ["staging", "production"])
async def test_openapi_disabled_in_staging_and_production(app_env: str) -> None:
    settings = make_settings(
        app_env=app_env,
        cors_allowed_origins="https://shop.example",
        telegram_environment="production",
    )
    app = create_app(settings, nonce_store=InMemoryNonceStore())
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        for path in ("/api/v1/openapi.json", "/api/v1/docs", "/openapi.json", "/docs"):
            assert (await http_client.get(path)).status_code == 404
        assert (await http_client.get("/api/v1/health")).status_code == 200


async def test_cors_only_allows_configured_origins() -> None:
    settings = make_settings(cors_allowed_origins="https://shop.example")
    app = create_app(settings, nonce_store=InMemoryNonceStore())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        allowed = await http_client.get(
            "/api/v1/health", headers={"Origin": "https://shop.example"}
        )
        denied = await http_client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert allowed.headers["access-control-allow-origin"] == "https://shop.example"
    assert "access-control-allow-origin" not in denied.headers


def test_verifier_selection(clock: FakeClock) -> None:
    default = build_identity_verifier(make_settings(), clock)
    assert isinstance(default, Ed25519InitDataVerifier)
    with_token = build_identity_verifier(make_settings(telegram_bot_token="1:fake-token"), clock)
    assert isinstance(with_token, HmacInitDataVerifier)


# --- POST /auth/telegram/init-data --------------------------------------------------------------


@pytest.fixture
def ed_app(app: FastAPI, clock: FakeClock) -> FastAPI:
    verifier = Ed25519InitDataVerifier(
        bot_id=7654321, public_key_hex=PUBLIC_KEY_HEX, max_age_seconds=MAX_AGE, clock=clock
    )
    app.dependency_overrides[get_identity_verifier] = lambda: verifier
    return app


async def test_init_data_upserts_and_returns_public_user(
    ed_app: FastAPI, client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    init_data = sign_ed25519(_base_fields(user=_user_json(language_code="ru")))
    response = await client.post(INIT_DATA_PATH, json={"init_data": init_data})
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["telegram_user_id"] == 123456789
    assert user["first_name"] == "Aziza"
    assert user["language"] == Language.RU
    assert "phone" not in user
    assert "is_blocked" not in user
    assert users.users[123456789].username == "aziza_k"


async def test_init_data_unsupported_language_defaults_to_uz(
    ed_app: FastAPI, client: httpx.AsyncClient
) -> None:
    init_data = sign_ed25519(_base_fields(user=_user_json(language_code="en")))
    response = await client.post(INIT_DATA_PATH, json={"init_data": init_data})
    assert response.json()["user"]["language"] == "uz"


async def test_init_data_rejects_invalid_signature(
    ed_app: FastAPI, client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    init_data = sign_ed25519(_base_fields()).replace("Aziza", "Mallory")
    response = await client.post(INIT_DATA_PATH, json={"init_data": init_data})
    assert response.status_code == 401
    assert response.json() == {
        "error": {"code": "unauthorized", "message": "Invalid Telegram init data"}
    }
    assert users.users == {}


async def test_init_data_rejects_garbage_with_401(
    ed_app: FastAPI, client: httpx.AsyncClient
) -> None:
    response = await client.post(INIT_DATA_PATH, json={"init_data": "garbage"})
    assert response.status_code == 401


async def test_init_data_with_hmac_verifier(
    app: FastAPI, client: httpx.AsyncClient, clock: FakeClock
) -> None:
    verifier = HmacInitDataVerifier(bot_token="1:fake-token", max_age_seconds=MAX_AGE, clock=clock)
    app.dependency_overrides[get_identity_verifier] = lambda: verifier
    init_data = sign_hmac(_base_fields(), token="1:fake-token")
    response = await client.post(INIT_DATA_PATH, json={"init_data": init_data})
    assert response.status_code == 200
