import dataclasses
import json
from typing import Any, cast

import httpx
import pytest
from pydantic import SecretStr
from redis.asyncio import Redis
from starlette.datastructures import Headers

from app.models.enums import Language
from app.repositories.users import TelegramProfile
from app.security.service_auth import (
    InMemoryNonceStore,
    RedisNonceStore,
    ServiceAuthenticator,
    ServiceAuthError,
    body_sha256_hex,
    canonical_string,
    sign,
)
from tests.conftest import NOW, TEST_KEY_ID, TEST_SECRET, FakeClock, FakeUserRepository

# ADR 0003 test vector.
VECTOR_SECRET = "test-only-secret-not-for-production-0001"
VECTOR = {
    "key_id": "test-key",
    "timestamp": "1767225600",
    "nonce": "n0nce-abc123-0001",
    "method": "POST",
    "path": "/api/v1/internal/telegram/session",
    "actor": "tg:123456789",
    "body": b'{"telegram_user_id":123456789}',
}
VECTOR_BODY_SHA256 = "c4c0f3c754b25d079cc6a56808b61d6967e6eb03feb9f39cb9ff6f5d9c8a12ec"
VECTOR_SIGNATURE = "4f759f2ee938c855bca8f77302d9ccd54ae37cbd52d0942eb9b4dee95c8a43fc"


def test_adr_0003_test_vector_body_hash() -> None:
    assert body_sha256_hex(cast("bytes", VECTOR["body"])) == VECTOR_BODY_SHA256


def test_adr_0003_test_vector_canonical_string() -> None:
    canonical = canonical_string(**cast("dict[str, Any]", VECTOR))
    assert canonical == "\n".join(
        [
            "MM-SVC-V1",
            "test-key",
            "1767225600",
            "n0nce-abc123-0001",
            "POST",
            "/api/v1/internal/telegram/session",
            "tg:123456789",
            VECTOR_BODY_SHA256,
        ]
    )
    assert not canonical.endswith("\n")
    assert len(canonical.split("\n")) == 8


def test_adr_0003_test_vector_signature() -> None:
    assert sign(secret=VECTOR_SECRET, **cast("dict[str, Any]", VECTOR)) == VECTOR_SIGNATURE


def test_empty_body_and_empty_actor_canonicalization() -> None:
    canonical = canonical_string(
        key_id="k",
        timestamp="1",
        nonce="n" * 16,
        method="get",
        path="/api/v1/internal/x?a=1",
        actor="",
        body=b"",
    )
    lines = canonical.split("\n")
    assert lines[4] == "GET"
    assert lines[5] == "/api/v1/internal/x?a=1"
    assert lines[6] == ""
    assert lines[7] == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


@pytest.mark.parametrize("field", ["timestamp", "path", "actor", "nonce", "key_id", "method"])
def test_changing_any_signed_field_changes_the_signature(field: str) -> None:
    changed = dict(VECTOR)
    changed[field] = "tg:42" if field == "actor" else "POSTX" if field == "method" else "other-1"
    assert sign(secret=VECTOR_SECRET, **cast("dict[str, Any]", changed)) != VECTOR_SIGNATURE


# --- authenticator (unit) ------------------------------------------------------------------


def _authenticator(clock: FakeClock) -> ServiceAuthenticator:
    return ServiceAuthenticator(
        keys={"test-key": SecretStr(VECTOR_SECRET)},
        nonce_store=InMemoryNonceStore(clock),
        clock=clock,
    )


def _vector_headers(**overrides: str) -> dict[str, str]:
    headers = {
        "X-MM-Key-Id": "test-key",
        "X-MM-Timestamp": "1767225600",
        "X-MM-Nonce": "n0nce-abc123-0001",
        "X-MM-Actor": "tg:123456789",
        "X-MM-Signature": VECTOR_SIGNATURE,
    }
    headers.update(overrides)
    return headers


async def test_authenticator_accepts_the_adr_vector(clock: FakeClock) -> None:
    context = await _authenticator(clock).authenticate(
        method="POST",
        path=cast("str", VECTOR["path"]),
        headers=Headers(_vector_headers()),
        body=cast("bytes", VECTOR["body"]),
    )
    assert context.key_id == "test-key"
    assert context.actor_telegram_user_id == 123456789


async def test_authenticator_actor_is_optional(clock: FakeClock) -> None:
    signature = sign(
        secret=VECTOR_SECRET,
        key_id="test-key",
        timestamp="1767225600",
        nonce="n0nce-abc123-0001",
        method="GET",
        path="/api/v1/internal/telegram/me",
        actor="",
        body=b"",
    )
    for headers in (
        _vector_headers(**{"X-MM-Actor": "", "X-MM-Signature": signature}),
        {
            k: v
            for k, v in _vector_headers(**{"X-MM-Signature": signature}).items()
            if k != "X-MM-Actor"
        },
    ):
        context = await _authenticator(FakeClock()).authenticate(
            method="GET",
            path="/api/v1/internal/telegram/me",
            headers=Headers(headers),
            body=b"",
        )
        assert context.actor_telegram_user_id is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"X-MM-Key-Id": ""},
        {"X-MM-Key-Id": "bad key"},
        {"X-MM-Key-Id": "k" * 33},
        {"X-MM-Timestamp": ""},
        {"X-MM-Timestamp": "17672256.5"},
        {"X-MM-Timestamp": "-1"},
        {"X-MM-Timestamp": "0x10"},
        {"X-MM-Timestamp": "1" * 13},
        {"X-MM-Nonce": ""},
        {"X-MM-Nonce": "short-nonce"},
        {"X-MM-Nonce": "n" * 65},
        {"X-MM-Nonce": "has spaces in it!!"},
        {"X-MM-Actor": "123456789"},
        {"X-MM-Actor": "tg:"},
        {"X-MM-Actor": "tg:abc"},
        {"X-MM-Actor": "tg:0"},
        {"X-MM-Actor": "tg:-5"},
        {"X-MM-Actor": "TG:123456789"},
        {"X-MM-Signature": ""},
        {"X-MM-Signature": VECTOR_SIGNATURE.upper()},
        {"X-MM-Signature": VECTOR_SIGNATURE[:-1]},
        {"X-MM-Signature": VECTOR_SIGNATURE + "0"},
    ],
)
async def test_authenticator_rejects_malformed_headers(
    clock: FakeClock, overrides: dict[str, str]
) -> None:
    with pytest.raises(ServiceAuthError):
        await _authenticator(clock).authenticate(
            method="POST",
            path=cast("str", VECTOR["path"]),
            headers=Headers(_vector_headers(**overrides)),
            body=cast("bytes", VECTOR["body"]),
        )


async def test_authenticator_missing_header(clock: FakeClock) -> None:
    headers = _vector_headers()
    del headers["X-MM-Nonce"]
    with pytest.raises(ServiceAuthError):
        await _authenticator(clock).authenticate(
            method="POST",
            path=cast("str", VECTOR["path"]),
            headers=Headers(headers),
            body=cast("bytes", VECTOR["body"]),
        )


async def test_skew_boundary_is_300_seconds(clock: FakeClock) -> None:
    for offset, ok in ((300, True), (-300, True), (301, False), (-301, False)):
        timestamp = str(int(NOW) + offset)
        headers = _vector_headers(
            **{
                "X-MM-Timestamp": timestamp,
                "X-MM-Signature": sign(
                    secret=VECTOR_SECRET,
                    **{**VECTOR, "timestamp": timestamp},  # type: ignore[arg-type]
                ),
            }
        )
        call = _authenticator(FakeClock()).authenticate(
            method="POST",
            path=cast("str", VECTOR["path"]),
            headers=Headers(headers),
            body=cast("bytes", VECTOR["body"]),
        )
        if ok:
            await call
        else:
            with pytest.raises(ServiceAuthError):
                await call


# --- nonce stores --------------------------------------------------------------------------


async def test_in_memory_nonce_store_expires_entries() -> None:
    clock = FakeClock()
    store = InMemoryNonceStore(clock)
    assert await store.register("k", "n" * 16, 660)
    assert not await store.register("k", "n" * 16, 660)
    assert await store.register("other", "n" * 16, 660)  # scoped per key id
    clock.now += 659
    assert not await store.register("k", "n" * 16, 660)
    clock.now += 2
    assert await store.register("k", "n" * 16, 660)


class _FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, tuple[str, int | None]] = {}
        self.calls: list[dict[str, Any]] = []

    async def set(
        self, name: str, value: str, *, nx: bool = False, ex: int | None = None
    ) -> bool | None:
        self.calls.append({"name": name, "value": value, "nx": nx, "ex": ex})
        if nx and name in self.data:
            return None
        self.data[name] = (value, ex)
        return True


async def test_redis_nonce_store_uses_set_nx_ex() -> None:
    fake = _FakeRedis()
    store = RedisNonceStore(cast("Redis", fake))
    assert await store.register("test-key", "n" * 16, 660)
    assert not await store.register("test-key", "n" * 16, 660)
    assert fake.calls[0]["nx"] is True
    assert fake.calls[0]["ex"] == 660
    assert fake.calls[0]["name"] == f"mm:svc-nonce:test-key:{'n' * 16}"


# --- HTTP integration through the internal router -------------------------------------------

SESSION_PATH = "/api/v1/internal/telegram/session"
ME_PATH = "/api/v1/internal/telegram/me"


def signed_headers(
    *,
    method: str,
    path: str,
    body: bytes = b"",
    actor: str = "tg:123456789",
    key_id: str = TEST_KEY_ID,
    secret: str = TEST_SECRET,
    timestamp: int | None = None,
    nonce: str = "nonce-0123456789abcdef",
) -> dict[str, str]:
    ts = str(int(NOW) if timestamp is None else timestamp)
    headers = {
        "X-MM-Key-Id": key_id,
        "X-MM-Timestamp": ts,
        "X-MM-Nonce": nonce,
        "X-MM-Actor": actor,
        "X-MM-Signature": sign(
            secret=secret,
            key_id=key_id,
            timestamp=ts,
            nonce=nonce,
            method=method,
            path=path,
            actor=actor,
            body=body,
        ),
    }
    if body:
        headers["Content-Type"] = "application/json"
    return headers


def _session_body(**overrides: Any) -> bytes:
    payload = {"telegram_user_id": 123456789, "first_name": "Aziza", **overrides}
    return json.dumps(payload, separators=(",", ":")).encode()


async def test_signed_session_upserts_user(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    body = _session_body(last_name="K", username="aziza", language_code="ru")
    response = await client.post(
        SESSION_PATH,
        content=body,
        headers=signed_headers(method="POST", path=SESSION_PATH, body=body),
    )
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["telegram_user_id"] == 123456789
    assert user["language"] == "ru"
    assert user["role"] == "customer"
    assert set(user) == {
        "id",
        "telegram_user_id",
        "first_name",
        "last_name",
        "username",
        "language",
        "role",
    }
    assert users.upserts == [
        TelegramProfile(123456789, "Aziza", "K", "aziza", "ru"),
    ]


async def test_me_returns_user_or_404(client: httpx.AsyncClient, users: FakeUserRepository) -> None:
    response = await client.get(ME_PATH, headers=signed_headers(method="GET", path=ME_PATH))
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "User not found"}}

    await users.upsert_from_telegram(TelegramProfile(123456789, "Aziza", language_code="uz"))
    response = await client.get(
        ME_PATH, headers=signed_headers(method="GET", path=ME_PATH, nonce="nonce-second-request-1")
    )
    assert response.status_code == 200
    assert response.json()["user"]["language"] == Language.UZ


async def test_me_with_query_string_is_signed_as_sent(client: httpx.AsyncClient) -> None:
    path = f"{ME_PATH}?a=1&b=%D1%84"
    response = await client.get(path, headers=signed_headers(method="GET", path=path))
    assert response.status_code == 404  # authenticated; user simply does not exist


GENERIC_401 = {"error": {"code": "unauthorized", "message": "Unauthorized"}}


async def test_unsigned_requests_get_generic_401(client: httpx.AsyncClient) -> None:
    for response in (
        await client.get(ME_PATH),
        await client.post(SESSION_PATH, json={"telegram_user_id": 1, "first_name": "x"}),
        await client.post(
            SESSION_PATH, content=b"{not json", headers={"Content-Type": "application/json"}
        ),
    ):
        assert response.status_code == 401
        assert response.json() == GENERIC_401


async def test_bad_signature_does_not_consume_the_nonce(client: httpx.AsyncClient) -> None:
    good = signed_headers(method="GET", path=ME_PATH)
    bad = {**good, "X-MM-Signature": "0" * 64}
    assert (await client.get(ME_PATH, headers=bad)).status_code == 401
    assert (await client.get(ME_PATH, headers=good)).status_code == 404


async def test_replayed_nonce_is_rejected(client: httpx.AsyncClient) -> None:
    headers = signed_headers(method="GET", path=ME_PATH)
    first = await client.get(ME_PATH, headers=headers)
    replay = await client.get(ME_PATH, headers=headers)
    assert first.status_code == 404
    assert replay.status_code == 401
    assert replay.json() == GENERIC_401


async def test_all_failures_are_indistinguishable(
    client: httpx.AsyncClient, clock: FakeClock
) -> None:
    body = _session_body()
    good = signed_headers(method="POST", path=SESSION_PATH, body=body)
    variants: dict[str, dict[str, str]] = {
        "bad signature": {**good, "X-MM-Signature": "a" * 64},
        "unknown key": signed_headers(method="POST", path=SESSION_PATH, body=body, key_id="nope"),
        "wrong secret": signed_headers(
            method="POST", path=SESSION_PATH, body=body, secret="x" * 40
        ),
        "stale": signed_headers(
            method="POST", path=SESSION_PATH, body=body, timestamp=int(NOW) - 301
        ),
        "future": signed_headers(
            method="POST", path=SESSION_PATH, body=body, timestamp=int(NOW) + 301
        ),
        "malformed": {**good, "X-MM-Nonce": "short"},
        "missing": {k: v for k, v in good.items() if k != "X-MM-Signature"},
    }
    for name, headers in variants.items():
        response = await client.post(SESSION_PATH, content=body, headers=headers)
        assert response.status_code == 401, name
        assert response.json() == GENERIC_401, name
        assert "www-authenticate" not in response.headers


async def test_tampered_actor_path_and_body_are_rejected(client: httpx.AsyncClient) -> None:
    body = _session_body()
    # Actor swapped after signing.
    headers = signed_headers(
        method="POST", path=SESSION_PATH, body=body, nonce="nonce-actor-swap-0001"
    )
    headers["X-MM-Actor"] = "tg:999"
    assert (await client.post(SESSION_PATH, content=body, headers=headers)).status_code == 401

    # Signed for /me, sent to /session.
    headers = signed_headers(method="POST", path=ME_PATH, body=body, nonce="nonce-path-swap-00001")
    assert (await client.post(SESSION_PATH, content=body, headers=headers)).status_code == 401

    # Signed for a different query string.
    headers = signed_headers(method="GET", path=f"{ME_PATH}?a=1", nonce="nonce-query-swap-0001")
    assert (await client.get(f"{ME_PATH}?a=2", headers=headers)).status_code == 401

    # Body modified after signing.
    headers = signed_headers(
        method="POST", path=SESSION_PATH, body=body, nonce="nonce-body-swap-0001"
    )
    evil = _session_body(first_name="Mallory")
    assert (await client.post(SESSION_PATH, content=evil, headers=headers)).status_code == 401

    # Method swapped.
    headers = signed_headers(method="POST", path=ME_PATH, nonce="nonce-method-swap-001")
    assert (await client.get(ME_PATH, headers=headers)).status_code == 401


async def test_actor_is_required_on_internal_routes(client: httpx.AsyncClient) -> None:
    response = await client.get(
        ME_PATH, headers=signed_headers(method="GET", path=ME_PATH, actor="")
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"

    body = _session_body()
    response = await client.post(
        SESSION_PATH,
        content=body,
        headers=signed_headers(
            method="POST", path=SESSION_PATH, body=body, actor="", nonce="nonce-no-actor-post-01"
        ),
    )
    assert response.status_code == 403


async def test_body_user_id_must_match_actor(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    body = _session_body(telegram_user_id=555)
    response = await client.post(
        SESSION_PATH,
        content=body,
        headers=signed_headers(method="POST", path=SESSION_PATH, body=body, actor="tg:123456789"),
    )
    assert response.status_code == 403
    assert users.upserts == []


@pytest.mark.parametrize(
    "body",
    [
        b"{not json",
        b"[]",
        b'{"first_name":"x"}',
        b'{"telegram_user_id":"abc","first_name":"x"}',
        b'{"telegram_user_id":123456789,"first_name":""}',
        b'{"telegram_user_id":123456789,"first_name":"x","extra":1}',
    ],
)
async def test_signed_but_invalid_body_is_422(client: httpx.AsyncClient, body: bytes) -> None:
    response = await client.post(
        SESSION_PATH,
        content=body,
        headers=signed_headers(method="POST", path=SESSION_PATH, body=body),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_blocked_users_are_refused(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    record = await users.upsert_from_telegram(TelegramProfile(123456789, "Aziza"))
    users.users[123456789] = dataclasses.replace(record, is_blocked=True)

    me = await client.get(ME_PATH, headers=signed_headers(method="GET", path=ME_PATH))
    assert me.status_code == 404

    body = _session_body()
    session = await client.post(
        SESSION_PATH,
        content=body,
        headers=signed_headers(
            method="POST", path=SESSION_PATH, body=body, nonce="nonce-blocked-user-001"
        ),
    )
    assert session.status_code == 403
