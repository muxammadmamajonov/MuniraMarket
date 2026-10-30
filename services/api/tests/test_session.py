"""Session store and policy (sliding idle TTL, absolute lifetime, rotation)."""

import hashlib
import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import cast

import pytest
from redis.asyncio import Redis

from app.security.session import (
    InMemorySessionStore,
    RedisSessionStore,
    SessionData,
    SessionManager,
    StoreUnavailableError,
    hash_token,
    is_well_formed_token,
    new_token,
)
from tests.auth_helpers import FakeRedis
from tests.conftest import NOW, FakeClock

DAY = 86400
IDLE = 7 * DAY
ABSOLUTE = 30 * DAY
ROTATE = DAY
USER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")


def _manager(store: InMemorySessionStore | RedisSessionStore, clock: FakeClock) -> SessionManager:
    return SessionManager(
        store=store,
        clock=clock,
        idle_ttl_seconds=IDLE,
        absolute_ttl_seconds=ABSOLUTE,
        rotate_after_seconds=ROTATE,
    )


@pytest.fixture
def store(clock: FakeClock) -> InMemorySessionStore:
    return InMemorySessionStore(clock)


@pytest.fixture
def manager(store: InMemorySessionStore, clock: FakeClock) -> SessionManager:
    return _manager(store, clock)


async def _create(manager: SessionManager, previous: str | None = None) -> tuple[str, SessionData]:
    issued = await manager.create(
        user_id=USER_ID,
        telegram_user_id=42,
        auth_method="telegram_init_data",
        previous_token=previous,
    )
    return issued.token, issued.data


async def _keep_alive(manager: SessionManager, token: str, clock: FakeClock, until: float) -> None:
    """Use the session every 6 days (inside the idle window) until ``until``."""
    while clock.now + 6 * DAY < until:
        clock.now += 6 * DAY
        assert await manager.load(token) is not None
    clock.now = until


def test_tokens_are_random_and_hashed_with_sha256() -> None:
    token = new_token()
    assert is_well_formed_token(token)
    assert token != new_token()
    assert hash_token(token) == hashlib.sha256(token.encode()).hexdigest()
    for bad in ("", "short", token + "x", token[:-1] + "!", token[:-1] + "="):
        assert not is_well_formed_token(bad)


def test_session_data_round_trips_and_rejects_garbage() -> None:
    data = SessionData(USER_ID, 42, "csrf", "telegram_login_widget", 10, 20)
    assert SessionData.from_json(data.to_json()) == data
    assert json.loads(data.to_json()) == {
        "user_id": str(USER_ID),
        "telegram_user_id": 42,
        "csrf_token": "csrf",
        "auth_method": "telegram_login_widget",
        "created_at": 10,
        "last_rotated_at": 20,
    }
    good = json.loads(data.to_json())
    for broken in (
        "[]",
        "not json",
        json.dumps({**good, "auth_method": "password"}),
        json.dumps({**good, "created_at": "10"}),
        json.dumps({**good, "telegram_user_id": True}),
        json.dumps({**good, "csrf_token": ""}),
        json.dumps({**good, "user_id": "nope"}),
    ):
        with pytest.raises(ValueError):  # noqa: PT011
            SessionData.from_json(broken)


async def test_create_and_load(manager: SessionManager, clock: FakeClock) -> None:
    token, data = await _create(manager)
    assert data.created_at == data.last_rotated_at == int(NOW)
    assert data.user_id == USER_ID
    assert data.csrf_token
    assert data.csrf_token != token
    loaded = await manager.load(token)
    assert loaded is not None
    assert loaded.data == data
    assert loaded.absolute_remaining_seconds == ABSOLUTE
    assert await manager.load(new_token()) is None
    assert await manager.load("malformed") is None


async def test_idle_expiry_slides_on_use(manager: SessionManager, clock: FakeClock) -> None:
    token, _ = await _create(manager)
    for _ in range(4):  # 4 x 6 days: well past one idle period, but always used in time
        clock.now += 6 * DAY
        assert await manager.load(token) is not None
    clock.now += IDLE + 1
    assert await manager.load(token) is None


async def test_absolute_expiry_even_when_active(manager: SessionManager, clock: FakeClock) -> None:
    token, _ = await _create(manager)
    await _keep_alive(manager, token, clock, NOW + ABSOLUTE - 1)
    loaded = await manager.load(token)
    assert loaded is not None
    assert loaded.absolute_remaining_seconds == 1
    clock.now += 1
    assert await manager.load(token) is None


async def test_idle_ttl_never_outlives_absolute_lifetime(
    store: InMemorySessionStore, manager: SessionManager, clock: FakeClock
) -> None:
    token, _ = await _create(manager)
    await _keep_alive(manager, token, clock, NOW + ABSOLUTE - 100)
    assert await manager.load(token) is not None  # TTL now capped at the 100 s left
    clock.now += 100
    assert len(store) == 0


async def test_rotation_after_threshold(manager: SessionManager, clock: FakeClock) -> None:
    token, data = await _create(manager)
    loaded = await manager.load(token)
    assert loaded is not None
    assert await manager.rotate_if_due(loaded) is None

    clock.now += ROTATE
    loaded = await manager.load(token)
    assert loaded is not None
    rotated = await manager.rotate_if_due(loaded)
    assert rotated is not None
    assert rotated.token != token
    assert rotated.data.csrf_token == data.csrf_token
    assert rotated.data.created_at == data.created_at  # absolute lifetime is not extended
    assert rotated.data.last_rotated_at == int(clock.now)
    assert rotated.max_age_seconds == ABSOLUTE - ROTATE
    assert await manager.load(token) is None
    assert await manager.load(rotated.token) is not None


async def test_create_revokes_the_previous_session(manager: SessionManager) -> None:
    old, _ = await _create(manager)
    new, _ = await _create(manager, previous=old)
    assert await manager.load(old) is None
    assert await manager.load(new) is not None


async def test_revoke_and_peek(manager: SessionManager, clock: FakeClock) -> None:
    token, data = await _create(manager)
    assert await manager.peek(token) == data
    await manager.revoke(token)
    assert await manager.peek(token) is None
    await manager.revoke("not-a-token")  # ignored


async def test_in_memory_store_drops_malformed_records(
    store: InMemorySessionStore, manager: SessionManager
) -> None:
    token, _ = await _create(manager)
    store._records[hash_token(token)] = ("{broken", NOW + 100)
    assert await manager.load(token) is None
    assert len(store) == 0


# --- Redis store: command shapes against a fake client -----------------------------------------


async def test_redis_store_commands(clock: FakeClock) -> None:
    fake = FakeRedis()
    manager = _manager(RedisSessionStore(cast("Redis", fake)), clock)
    token, data = await _create(manager)
    key = f"mm:sess:{hashlib.sha256(token.encode()).hexdigest()}"
    assert fake.commands == [("SET", key, data.to_json(), "EX", IDLE)]
    assert token not in json.dumps(fake.commands)  # only the hash is stored

    fake.commands.clear()
    clock.now += 10
    assert await manager.load(token) is not None
    assert fake.commands == [("GET", key), ("EXPIRE", key, IDLE)]

    fake.commands.clear()
    clock.now += ROTATE
    loaded = await manager.load(token)
    assert loaded is not None
    rotated = await manager.rotate_if_due(loaded)
    assert rotated is not None
    new_key = f"mm:sess:{hash_token(rotated.token)}"
    assert fake.commands[2:] == [
        ("MULTI",),
        ("SET", new_key, rotated.data.to_json(), "EX", IDLE),
        ("DEL", key),
        ("EXEC",),
    ]

    fake.commands.clear()
    await manager.revoke(rotated.token)
    assert fake.commands == [("DEL", new_key)]


async def test_redis_store_discards_malformed_records(clock: FakeClock) -> None:
    fake = FakeRedis()
    store = RedisSessionStore(cast("Redis", fake))
    fake.data["mm:sess:abc"] = "{broken"
    assert await store.get("abc") is None
    assert "mm:sess:abc" not in fake.data


async def test_redis_errors_become_store_unavailable(clock: FakeClock) -> None:
    store = RedisSessionStore(cast("Redis", FakeRedis(fail=True)))
    data = SessionData(USER_ID, 42, "csrf", "telegram_init_data", 1, 1)
    with pytest.raises(StoreUnavailableError):
        await store.get("abc")
    with pytest.raises(StoreUnavailableError):
        await store.set("abc", data, 10)
    with pytest.raises(StoreUnavailableError):
        await store.expire("abc", 10)
    with pytest.raises(StoreUnavailableError):
        await store.delete("abc")
    with pytest.raises(StoreUnavailableError):
        await store.replace("abc", "def", data, 10)


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
async def test_real_redis_session_lifecycle(real_redis: Redis, clock: FakeClock) -> None:
    prefix = f"mm:test:{uuid.uuid4().hex}:sess"
    manager = _manager(RedisSessionStore(real_redis, prefix=prefix), clock)
    token, data = await _create(manager)
    key = f"{prefix}:{hash_token(token)}"
    try:
        assert 0 < await real_redis.ttl(key) <= IDLE
        loaded = await manager.load(token)
        assert loaded is not None
        assert loaded.data == data
        clock.now += ROTATE
        loaded = await manager.load(token)
        assert loaded is not None
        rotated = await manager.rotate_if_due(loaded)
        assert rotated is not None
        assert await real_redis.exists(key) == 0
        await manager.revoke(rotated.token)
        assert await manager.load(rotated.token) is None
    finally:
        await real_redis.delete(key)
