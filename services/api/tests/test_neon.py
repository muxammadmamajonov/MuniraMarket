"""Neon wiring: URL conversion, env mapping, Neon Auth JWT verification, storage selection."""

import base64
import json
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.db.neon_url import asyncpg_url_from_neon
from app.dev.neon_env import api_values, merge, parse_dotenv
from app.main import create_app
from app.security import neon_auth
from app.security.neon_auth import NeonAuthError, NeonAuthVerifier
from app.storage.images import DisabledImageStorage, S3ImageStorage, create_image_storage
from tests.conftest import make_settings

BASE_URL = "https://ep-x.neonauth.eu-central-1.aws.neon.tech/neondb/auth"
JWKS_URL = f"{BASE_URL}/.well-known/jwks.json"
ISSUER = "https://ep-x.neonauth.eu-central-1.aws.neon.tech"
NOW = 1_800_000_000
STORAGE = {
    "object_storage_bucket": "assets",
    "object_storage_endpoint_url": "https://storage.example",
    "object_storage_access_key_id": "id",
    "object_storage_secret_access_key": "secret",
}


def test_neon_url_becomes_asyncpg_verify_full() -> None:
    raw = "postgresql://u:p@ep-a.c-7.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    assert asyncpg_url_from_neon(raw) == (
        "postgresql+asyncpg://u:p@ep-a.c-7.eu-central-1.aws.neon.tech/neondb?ssl=verify-full"
    )


def test_neon_pooler_url_is_refused() -> None:
    with pytest.raises(ValueError, match="direct endpoint"):
        asyncpg_url_from_neon("postgresql://u:p@ep-a-pooler.neon.tech/db?sslmode=require")


def test_env_mapping_and_merge_keep_other_keys() -> None:
    neon = parse_dotenv(
        "DATABASE_URL_UNPOOLED='postgresql://u:p@ep-a.neon.tech/db?sslmode=require'\n"
        f"NEON_AUTH_BASE_URL={BASE_URL}\nNEON_AUTH_JWKS_URL={JWKS_URL}\n"
        "AWS_ENDPOINT_URL_S3=https://s3.example\nAWS_REGION=eu-central-1\n"
        "AWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=secret\n"
    )
    values = api_values(neon)
    assert values["DATABASE_URL"].endswith("?ssl=verify-full")
    assert values["OBJECT_STORAGE_BUCKET"] == "assets"
    merged = merge("APP_ENV=development\nDATABASE_URL=old\n", values)
    assert "APP_ENV=development" in merged
    assert merged.count("DATABASE_URL=") == 1
    assert "DATABASE_URL=old" not in merged


def test_env_mapping_requires_every_variable() -> None:
    with pytest.raises(ValueError, match="DATABASE_URL_UNPOOLED"):
        api_values({})


def test_object_storage_settings_are_all_or_nothing() -> None:
    with pytest.raises(ValidationError):
        make_settings(object_storage_bucket="assets")
    assert isinstance(create_image_storage(make_settings()), DisabledImageStorage)
    assert isinstance(create_image_storage(make_settings(**STORAGE)), S3ImageStorage)


def test_neon_auth_settings_must_be_https_and_paired() -> None:
    with pytest.raises(ValidationError):
        make_settings(neon_auth_base_url=BASE_URL)
    with pytest.raises(ValidationError):
        make_settings(neon_auth_base_url="http://x", neon_auth_jwks_url="http://x/jwks")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Signer:
    def __init__(self, kid: str = "k1") -> None:
        self.kid = kid
        self.key = Ed25519PrivateKey.generate()

    def jwks(self) -> dict[str, Any]:
        x = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return {"keys": [{"kty": "OKP", "crv": "Ed25519", "kid": self.kid, "x": _b64(x)}]}

    def token(self, **claims: Any) -> str:
        payload = {"sub": "user-1", "iss": ISSUER, "exp": NOW + 600, "email": "a@b.uz"} | claims
        header = _b64(json.dumps({"alg": "EdDSA", "kid": self.kid}).encode())
        body = _b64(json.dumps(payload).encode())
        signature = self.key.sign(f"{header}.{body}".encode())
        return f"{header}.{body}.{_b64(signature)}"


@pytest.fixture
def signer(monkeypatch: pytest.MonkeyPatch) -> Signer:
    signer = Signer()
    monkeypatch.setattr(neon_auth, "_fetch_jwks", lambda _url: signer.jwks())
    return signer


def _verifier() -> NeonAuthVerifier:
    return NeonAuthVerifier(base_url=BASE_URL, jwks_url=JWKS_URL, now=lambda: NOW)


async def test_valid_neon_token_is_accepted(signer: Signer) -> None:
    identity = await _verifier().verify(signer.token())
    assert identity.user_id == "user-1"
    assert identity.email == "a@b.uz"


@pytest.mark.parametrize(
    "claims",
    [{"exp": NOW - 3600}, {"iss": "https://evil.example"}, {"sub": ""}, {"nbf": NOW + 3600}],
)
async def test_bad_claims_are_refused(signer: Signer, claims: dict[str, Any]) -> None:
    with pytest.raises(NeonAuthError):
        await _verifier().verify(signer.token(**claims))


async def test_token_from_another_key_is_refused(signer: Signer) -> None:
    with pytest.raises(NeonAuthError):
        await _verifier().verify(Signer(kid=signer.kid).token())


async def test_garbage_token_is_refused(signer: Signer) -> None:
    with pytest.raises(NeonAuthError):
        await _verifier().verify("not.a.jwt")


async def test_neon_me_route(signer: Signer) -> None:
    app = create_app(make_settings(neon_auth_base_url=BASE_URL, neon_auth_jwks_url=JWKS_URL))
    app.state.neon_auth_verifier = _verifier()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as client:
        ok = await client.get(
            "/api/v1/auth/neon/me", headers={"authorization": f"Bearer {signer.token()}"}
        )
        missing = await client.get("/api/v1/auth/neon/me")
    assert ok.status_code == 200
    assert ok.json() == {"user_id": "user-1", "email": "a@b.uz", "name": None}
    assert missing.status_code == 401


async def test_neon_me_route_disabled_without_config() -> None:
    app = create_app(make_settings())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as client:
        response = await client.get("/api/v1/auth/neon/me", headers={"authorization": "Bearer x"})
    assert response.status_code == 503
