"""Telegram OIDC sign-in (ADR 0014): id_token verification, PKCE, the HTTP provider and routes.

A local RSA key pair signs test tokens; nothing here talks to Telegram.
"""

import base64
import dataclasses
import json
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from fastapi import FastAPI

from app.api.routes.auth import safe_return_to
from app.models.enums import UserRole
from app.telegram.oidc import (
    CALLBACK_PATH,
    HttpOidcProvider,
    OidcClient,
    OidcEndpoints,
    OidcError,
    b64url_encode,
    code_challenge,
    rsa_key_from_jwk,
    verify_id_token,
)
from tests.auth_helpers import (
    CONFIG_PATH,
    OIDC_CALLBACK_PATH,
    OIDC_START_PATH,
    SECURE_COOKIE,
    build_app,
    cookie_header,
    http_client,
    set_cookies,
)
from tests.conftest import NOW, FakeClock, FakeUserRepository

ISSUER = "https://oauth.telegram.org"
CLIENT_ID = 9038491407
WEB = "https://shop.example"
ADMIN = "https://admin.example"
TG_ID = 987654321
KID = "oidc-1"
BINDING_COOKIE = "__Host-mm_oidc"

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _int_b64(value: int) -> str:
    return b64url_encode(value.to_bytes((value.bit_length() + 7) // 8, "big"))


def jwk(key: rsa.RSAPrivateKey = PRIVATE_KEY, kid: str = KID) -> dict[str, str]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": _int_b64(numbers.n),
        "e": _int_b64(numbers.e),
    }


def claims(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "iss": ISSUER,
        "aud": str(CLIENT_ID),
        "sub": "1234123412341234123",
        "iat": int(NOW),
        "exp": int(NOW) + 3600,
        "nonce": "expected-nonce",
        "id": TG_ID,
        "name": "Munira Test",
        "given_name": "Munira",
        "family_name": "Test",
        "preferred_username": "munira_test",
    }
    values.update(overrides)
    return {key: value for key, value in values.items() if value is not None}


def make_token(
    payload: dict[str, Any],
    *,
    key: rsa.RSAPrivateKey = PRIVATE_KEY,
    header: dict[str, Any] | None = None,
) -> str:
    head = header if header is not None else {"alg": "RS256", "typ": "JWT", "kid": KID}
    signing_input = (
        b64url_encode(json.dumps(head).encode()) + "." + b64url_encode(json.dumps(payload).encode())
    )
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{b64url_encode(signature)}"


def verify(token: str, **kwargs: Any) -> Any:
    options: dict[str, Any] = {
        "key": PRIVATE_KEY.public_key(),
        "issuer": ISSUER,
        "client_id": CLIENT_ID,
        "nonce": "expected-nonce",
        "now": NOW,
    }
    options.update(kwargs)
    return verify_id_token(token, **options)


# --- id_token verification --------------------------------------------------------------------


def test_valid_token_yields_the_telegram_id_not_sub() -> None:
    identity = verify(make_token(claims()))
    assert identity.telegram_user_id == TG_ID
    assert identity.first_name == "Munira"
    assert identity.last_name == "Test"
    assert identity.username == "munira_test"


def test_name_falls_back_to_name_claim() -> None:
    identity = verify(make_token(claims(given_name=None, family_name=None)))
    assert identity.first_name == "Munira Test"
    assert identity.last_name is None


def test_audience_list_requires_azp() -> None:
    assert verify(make_token(claims(aud=[str(CLIENT_ID)]))).telegram_user_id == TG_ID
    with pytest.raises(OidcError, match="azp_mismatch"):
        verify(make_token(claims(aud=[str(CLIENT_ID), "other"])))
    token = make_token(claims(aud=[str(CLIENT_ID), "other"], azp=str(CLIENT_ID)))
    assert verify(token).telegram_user_id == TG_ID


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"iss": "https://evil.example"}, "iss_mismatch"),
        ({"aud": "123"}, "aud_mismatch"),
        ({"aud": None}, "aud_mismatch"),
        ({"exp": int(NOW) - 61}, "expired"),
        ({"exp": None}, "claim_exp_invalid"),
        ({"iat": int(NOW) + 61}, "iat_in_future"),
        ({"nonce": "other-nonce"}, "nonce_mismatch"),
        ({"nonce": None}, "nonce_mismatch"),
        ({"id": None}, "claim_id_invalid"),
        ({"id": "987654321"}, "claim_id_invalid"),
        ({"id": 0}, "claim_id_invalid"),
        ({"id": True}, "claim_id_invalid"),
        ({"name": None, "given_name": None}, "claim_name_missing"),
    ],
)
def test_claim_checks(overrides: dict[str, Any], reason: str) -> None:
    with pytest.raises(OidcError) as excinfo:
        verify(make_token(claims(**overrides)))
    assert excinfo.value.reason == reason


def test_exp_leeway_is_sixty_seconds() -> None:
    assert verify(make_token(claims(exp=int(NOW) - 59))).telegram_user_id == TG_ID


def test_signature_by_another_key_is_refused() -> None:
    with pytest.raises(OidcError, match="bad_signature"):
        verify(make_token(claims(), key=OTHER_KEY))


def test_tampered_payload_is_refused() -> None:
    token = make_token(claims())
    head, _, signature = token.split(".")
    forged = b64url_encode(json.dumps(claims(id=1)).encode())
    with pytest.raises(OidcError, match="bad_signature"):
        verify(f"{head}.{forged}.{signature}")


@pytest.mark.parametrize(
    "header",
    [
        {"alg": "none", "kid": KID},
        {"alg": "HS256", "kid": KID},
        {"alg": "ES256", "kid": KID},
        {"alg": "RS256"},
        {"alg": "RS256", "kid": "bad kid with spaces"},
    ],
)
def test_only_rs256_with_a_kid_is_accepted(header: dict[str, Any]) -> None:
    with pytest.raises(OidcError):
        verify(make_token(claims(), header=header))


@pytest.mark.parametrize("token", ["", "a.b", "a.b.c.d", "!!.@@.##", "x" * 20000])
def test_malformed_tokens(token: str) -> None:
    with pytest.raises(OidcError):
        verify(token)


def test_pkce_s256_matches_rfc7636_appendix_b() -> None:
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert code_challenge(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_jwk_parsing_refuses_weak_or_foreign_keys() -> None:
    assert isinstance(rsa_key_from_jwk(jwk()), rsa.RSAPublicKey)
    small = rsa.generate_private_key(public_exponent=65537, key_size=1024)  # noqa: S505
    for bad in (
        jwk(small),
        {**jwk(), "kty": "EC"},
        {**jwk(), "alg": "RS512"},
        {**jwk(), "use": "enc"},
        {**jwk(), "n": 5},
    ):
        with pytest.raises(OidcError):
            rsa_key_from_jwk(bad)


# --- HTTP provider (token endpoint + JWKS) ------------------------------------------------------


class Recorder:
    def __init__(self, token_status: int = 200, token_body: Any = None) -> None:
        self.requests: list[httpx.Request] = []
        self.jwks_calls = 0
        self.token_status = token_status
        self.token_body = token_body if token_body is not None else {"id_token": "the.id.token"}
        ec_key = ec.generate_private_key(ec.SECP256R1()).public_key().public_numbers()
        self.keys: list[dict[str, Any]] = [
            jwk(),
            {"kty": "EC", "kid": "ec-1", "crv": "P-256", "x": _int_b64(ec_key.x)},
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/token":
            return httpx.Response(self.token_status, json=self.token_body)
        if request.url.path == "/.well-known/jwks.json":
            self.jwks_calls += 1
            return httpx.Response(200, json={"keys": self.keys})
        return httpx.Response(404)


def provider(recorder: Recorder, clock: FakeClock) -> HttpOidcProvider:
    return HttpOidcProvider(
        endpoints=OidcEndpoints(ISSUER),
        client_id=CLIENT_ID,
        client_secret="test-only-client-secret",
        clock=clock,
        transport=httpx.MockTransport(recorder.handler),
    )


async def test_code_exchange_uses_basic_auth_and_pkce(clock: FakeClock) -> None:
    recorder = Recorder()
    id_token = await provider(recorder, clock).exchange_code(
        code="the-code", redirect_uri=f"{WEB}{CALLBACK_PATH}", code_verifier="v" * 64
    )
    assert id_token == "the.id.token"
    [request] = recorder.requests
    assert str(request.url) == "https://oauth.telegram.org/token"
    expected = base64.b64encode(f"{CLIENT_ID}:test-only-client-secret".encode()).decode()
    assert request.headers["authorization"] == f"Basic {expected}"
    form = parse_qs(request.content.decode())
    assert form == {
        "grant_type": ["authorization_code"],
        "code": ["the-code"],
        "redirect_uri": [f"{WEB}{CALLBACK_PATH}"],
        "client_id": [str(CLIENT_ID)],
        "code_verifier": ["v" * 64],
    }


@pytest.mark.parametrize(
    ("status", "body", "reason"),
    [
        (400, {"error": "invalid_grant"}, "token_endpoint_400"),
        (200, {"access_token": "x"}, "token_response_without_id_token"),
        (200, ["not", "an", "object"], "token_response_without_id_token"),
    ],
)
async def test_code_exchange_failures(
    clock: FakeClock, status: int, body: Any, reason: str
) -> None:
    recorder = Recorder(token_status=status, token_body=body)
    with pytest.raises(OidcError) as excinfo:
        await provider(recorder, clock).exchange_code(code="c", redirect_uri="r", code_verifier="v")
    assert excinfo.value.reason == reason
    assert "test-only-client-secret" not in str(excinfo.value)


async def test_jwks_is_cached_and_refreshed_for_unknown_kids(clock: FakeClock) -> None:
    recorder = Recorder()
    oidc = provider(recorder, clock)
    assert isinstance(await oidc.signing_key(KID), rsa.RSAPublicKey)
    assert isinstance(await oidc.signing_key(KID), rsa.RSAPublicKey)
    assert recorder.jwks_calls == 1  # cached
    with pytest.raises(OidcError, match="unknown_kid"):
        await oidc.signing_key("rotated")  # within the refresh interval: no refetch
    assert recorder.jwks_calls == 1
    clock.now += 61
    recorder.keys.append(jwk(OTHER_KEY, kid="rotated"))
    assert isinstance(await oidc.signing_key("rotated"), rsa.RSAPublicKey)
    assert recorder.jwks_calls == 2
    with pytest.raises(OidcError, match="unknown_kid"):
        await oidc.signing_key("ec-1")  # only RSA keys are kept


# --- routes -------------------------------------------------------------------------------------


@dataclasses.dataclass
class FakeProvider:
    """Issues an id_token for the nonce of the code it was given; records every exchange."""

    nonce_for_code: dict[str, str] = dataclasses.field(default_factory=dict)
    exchanges: list[dict[str, str]] = dataclasses.field(default_factory=list)
    telegram_id: int = TG_ID
    fail: bool = False

    async def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> str:
        self.exchanges.append(
            {"code": code, "redirect_uri": redirect_uri, "code_verifier": code_verifier}
        )
        if self.fail:
            raise OidcError("token_endpoint_400")
        return make_token(claims(nonce=self.nonce_for_code.get(code, "?"), id=self.telegram_id))

    async def signing_key(self, kid: str) -> rsa.RSAPublicKey:
        assert kid == KID
        return PRIVATE_KEY.public_key()


def oidc_app(
    clock: FakeClock, users: FakeUserRepository, fake: FakeProvider, **overrides: Any
) -> FastAPI:
    values: dict[str, Any] = {
        "telegram_oidc_enabled": True,
        "telegram_oidc_client_id": CLIENT_ID,
        "telegram_oidc_client_secret": "test-only-client-secret",
        "web_public_origin": WEB,
        "admin_public_origin": ADMIN,
        "csrf_trusted_origins": f"{WEB},{ADMIN}",
    }
    values.update(overrides)
    endpoints = OidcEndpoints(ISSUER)
    return build_app(
        clock,
        users,
        oidc_client=OidcClient(
            endpoints=endpoints, client_id=CLIENT_ID, provider=fake, state_ttl_seconds=600
        ),
        **values,
    )


@pytest.fixture
def fake() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
async def api(
    clock: FakeClock, users: FakeUserRepository, fake: FakeProvider
) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(oidc_app(clock, users, fake)) as client:
        yield client


@dataclasses.dataclass
class Started:
    state: str
    nonce: str
    binding: str
    query: dict[str, list[str]]


async def start(
    api: httpx.AsyncClient, *, entrance: str = "storefront", return_to: str | None = "/uz/orders"
) -> Started:
    origin = ADMIN if entrance == "admin" else WEB
    response = await api.post(
        OIDC_START_PATH,
        json={} if return_to is None else {"return_to": return_to},
        headers={"Origin": origin, "X-MM-Entrance": entrance},
    )
    assert response.status_code == 200, response.text
    url = urlsplit(response.json()["authorization_url"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://oauth.telegram.org/auth"
    query = parse_qs(url.query)
    [binding] = [c for c in set_cookies(response) if c.name == BINDING_COOKIE]
    assert {"httponly", "secure", "path"} <= binding.attributes.keys()
    assert binding.attributes["samesite"] == "Lax"
    assert int(binding.attributes["max-age"]) == 600
    return Started(query["state"][0], query["nonce"][0], binding.value, query)


async def callback(
    api: httpx.AsyncClient,
    started: Started,
    fake: FakeProvider,
    *,
    entrance: str = "storefront",
    binding: str | None = None,
    code: str | None = "auth-code-1",
) -> httpx.Response:
    if code is not None:
        fake.nonce_for_code[code] = started.nonce
    params = {"state": started.state, **({"code": code} if code is not None else {})}
    cookie = binding if binding is not None else started.binding
    return await api.get(
        OIDC_CALLBACK_PATH,
        params=params,
        headers={"Cookie": f"{BINDING_COOKIE}={cookie}", "X-MM-Entrance": entrance},
    )


async def test_config_reports_oidc_enabled(api: httpx.AsyncClient) -> None:
    response = await api.get(CONFIG_PATH)
    assert response.json() == {"telegram_oidc": {"enabled": True}}


async def test_start_builds_a_pkce_authorization_request(api: httpx.AsyncClient) -> None:
    started = await start(api)
    query = started.query
    assert query["response_type"] == ["code"]
    assert query["client_id"] == [str(CLIENT_ID)]
    assert query["redirect_uri"] == [f"{WEB}{CALLBACK_PATH}"]
    assert query["scope"] == ["openid profile"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) == 43
    assert "client_secret" not in str(query)
    admin = await start(api, entrance="admin")
    assert admin.query["redirect_uri"] == [f"{ADMIN}{CALLBACK_PATH}"]
    assert admin.state != started.state


async def test_start_requires_a_trusted_origin(api: httpx.AsyncClient) -> None:
    response = await api.post(OIDC_START_PATH, json={}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_full_storefront_login(
    api: httpx.AsyncClient, fake: FakeProvider, users: FakeUserRepository
) -> None:
    started = await start(api)
    response = await callback(api, started, fake)
    assert response.status_code == 303
    assert response.headers["location"] == "/uz/orders"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-store"
    cookies = {c.name: c for c in set_cookies(response)}
    assert cookies[BINDING_COOKIE].attributes["max-age"] == "0"  # binding consumed
    session_cookie = cookies[SECURE_COOKIE]
    [exchange] = fake.exchanges
    assert exchange["redirect_uri"] == f"{WEB}{CALLBACK_PATH}"
    assert code_challenge(exchange["code_verifier"]) == started.query["code_challenge"][0]
    assert users.users[TG_ID].first_name == "Munira"

    me = await api.get("/api/v1/auth/session", headers=cookie_header(session_cookie.value))
    assert me.status_code == 200
    assert me.json()["user"]["telegram_user_id"] == TG_ID


async def test_state_is_single_use(api: httpx.AsyncClient, fake: FakeProvider) -> None:
    started = await start(api)
    assert SECURE_COOKIE in {c.name for c in set_cookies(await callback(api, started, fake))}
    replay = await callback(api, started, fake, code="auth-code-2")
    assert replay.headers["location"] == "/uz/auth/telegram?status=failed"
    assert SECURE_COOKIE not in {c.name for c in set_cookies(replay)}
    assert len(fake.exchanges) == 1


async def test_callback_in_another_browser_fails(
    api: httpx.AsyncClient, fake: FakeProvider
) -> None:
    """Login CSRF: a victim opening the attacker's callback URL has no matching binding."""
    started = await start(api)
    response = await callback(api, started, fake, binding="A" * 43)
    assert response.headers["location"] == "/uz/auth/telegram?status=failed"
    assert fake.exchanges == []
    assert SECURE_COOKIE not in {c.name for c in set_cookies(response)}


async def test_callback_on_the_other_origin_fails(
    api: httpx.AsyncClient, fake: FakeProvider
) -> None:
    started = await start(api, entrance="storefront")
    response = await callback(api, started, fake, entrance="admin")
    assert response.headers["location"] == "/uz/auth/telegram?status=failed"
    assert fake.exchanges == []


async def test_cancelled_and_failed_exchanges(api: httpx.AsyncClient, fake: FakeProvider) -> None:
    cancelled = await callback(api, await start(api, return_to="/ru/cart"), fake, code=None)
    assert cancelled.headers["location"] == "/ru/auth/telegram?status=cancelled"
    fake.fail = True
    failed = await callback(api, await start(api), fake)
    assert failed.headers["location"] == "/uz/auth/telegram?status=failed"


async def test_unknown_or_malformed_state(api: httpx.AsyncClient) -> None:
    for params in ({"state": "x" * 43, "code": "c"}, {"state": "bad", "code": "c"}, {}):
        response = await api.get(OIDC_CALLBACK_PATH, params=params)
        assert response.status_code == 303
        assert response.headers["location"] == "/uz/auth/telegram?status=failed"


async def test_nonce_must_match(api: httpx.AsyncClient, fake: FakeProvider) -> None:
    started = await start(api)
    started_other = await start(api)
    fake.nonce_for_code["c-1"] = started_other.nonce  # a token minted for another login
    response = await api.get(
        OIDC_CALLBACK_PATH,
        params={"state": started.state, "code": "c-1"},
        headers={"Cookie": f"{BINDING_COOKIE}={started.binding}"},
    )
    assert response.headers["location"] == "/uz/auth/telegram?status=failed"


async def test_expired_state_is_refused(
    api: httpx.AsyncClient, fake: FakeProvider, clock: FakeClock
) -> None:
    started = await start(api)
    clock.now += 601
    response = await callback(api, started, fake)
    assert response.headers["location"] == "/uz/auth/telegram?status=failed"


async def test_blocked_user_cannot_sign_in(
    api: httpx.AsyncClient, fake: FakeProvider, users: FakeUserRepository
) -> None:
    await callback(api, await start(api), fake)
    record = users.users[TG_ID]
    users.users[TG_ID] = dataclasses.replace(record, is_blocked=True)
    response = await callback(api, await start(api), fake, code="auth-code-3")
    assert response.headers["location"] == "/uz/auth/telegram?status=blocked"
    assert SECURE_COOKIE not in {c.name for c in set_cookies(response)}


async def test_admin_and_storefront_sessions_are_bound_to_their_entrance(
    clock: FakeClock, users: FakeUserRepository, fake: FakeProvider
) -> None:
    app = oidc_app(clock, users, fake)
    async with http_client(app) as client:
        storefront = await callback(client, await start(client), fake)
        users.users[TG_ID] = dataclasses.replace(users.users[TG_ID], role=UserRole.ADMIN)
        storefront_token = {c.name: c for c in set_cookies(storefront)}[SECURE_COOKIE].value
        # Even for an admin, a storefront session is never a back-office credential.
        refused = await client.get("/api/v1/admin/orders", headers=cookie_header(storefront_token))
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "forbidden"

        admin = await callback(
            client,
            await start(client, entrance="admin", return_to="/uz"),
            fake,
            entrance="admin",
            code="auth-code-admin",
        )
        assert admin.headers["location"] == "/uz"
        admin_token = {c.name: c for c in set_cookies(admin)}[SECURE_COOKIE].value
    manager = app.state.session_manager
    storefront_session = await manager.peek(storefront_token)
    admin_session = await manager.peek(admin_token)
    assert storefront_session is not None
    assert admin_session is not None
    assert (storefront_session.auth_method, storefront_session.entrance) == (
        "telegram_oidc",
        "storefront",
    )
    # Same Telegram user and bot on both origins; the role is checked on every request.
    assert (admin_session.auth_method, admin_session.entrance) == ("telegram_oidc", "admin")
    assert admin_session.telegram_user_id == storefront_session.telegram_user_id == TG_ID


async def test_deployed_without_gateway_entrance_is_disabled(
    clock: FakeClock, users: FakeUserRepository, fake: FakeProvider
) -> None:
    app = oidc_app(
        clock,
        users,
        fake,
        app_env="production",
        database_url="postgresql+asyncpg://fake:pw@127.0.0.1:1/fake?ssl=verify-full",
        cors_allowed_origins="",
        telegram_environment="production",
        web_public_origin="https://shop.example",
        admin_public_origin="https://admin.example",
    )
    async with http_client(app) as client:
        config = await client.get(CONFIG_PATH)
        start_response = await client.post(OIDC_START_PATH, json={}, headers={"Origin": WEB})
    assert config.json() == {"telegram_oidc": {"enabled": False}}
    assert start_response.status_code == 404


async def test_disabled_oidc_is_404(clock: FakeClock, users: FakeUserRepository) -> None:
    async with http_client(build_app(clock, users)) as client:
        response = await client.post(
            OIDC_START_PATH, json={}, headers={"Origin": "https://shop.example"}
        )
        callback_response = await client.get(OIDC_CALLBACK_PATH, params={"state": "x"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "feature_disabled"
    assert callback_response.status_code == 404


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, "/"),
        ("/uz/orders?tab=1", "/uz/orders?tab=1"),
        ("//evil.example/x", "/"),
        ("/\\evil.example", "/"),
        ("https://evil.example/", "/"),
        ("uz/orders", "/"),
        ("/uz/\nSet-Cookie:x", "/"),
        ("/" + "a" * 600, "/"),
    ],
)
def test_return_to_is_a_same_origin_path(value: str | None, expected: str) -> None:
    assert safe_return_to(value) == expected
