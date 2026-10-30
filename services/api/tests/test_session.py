"""Session store and policy (sliding idle TTL, absolute lifetime, rotation)."""

import hashlib
import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import cast

import pytest
from redis.asyncio import Redis

from app.security import session as session_module
from app.security.session import (
    ROTATE_SESSION_LUA,
    InMemorySessionStore,
    RedisSessionStore,
    RotatedTombstone,
    SessionData,
    SessionGoneError,
    SessionManager,
    StoreUnavailableError,
    SwapResult,
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


@pytest.mark.parametrize("backend", ["memory", "redis"])
async def test_rotation_never_resurrects_a_revoked_session(clock: FakeClock, backend: str) -> None:
    fake = FakeRedis()
    store = (
        InMemorySessionStore(clock)
        if backend == "memory"
        else RedisSessionStore(cast("Redis", fake))
    )
    manager = _manager(store, clock)
    token, _ = await _create(manager)
    clock.now += ROTATE
    loaded = await manager.load(token)
    assert loaded is not None
    await manager.revoke(token)  # concurrent logout / block between load and rotation
    with pytest.raises(SessionGoneError):
        await manager.rotate_if_due(loaded)
    if isinstance(store, InMemorySessionStore):
        assert len(store) == 0
    else:
        assert fake.data == {}


async def test_touch_never_recreates_a_deleted_session(
    store: InMemorySessionStore, manager: SessionManager
) -> None:
    token, _ = await _create(manager)
    await manager.revoke(token)
    assert await store.expire(hash_token(token), IDLE) is False
    assert len(store) == 0
    fake = FakeRedis()
    assert await RedisSessionStore(cast("Redis", fake)).expire("gone", IDLE) is False
    assert fake.data == {}


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


# --- rotation grace period (tombstones) -------------------------------------------------------

GRACE = 60


def _store(
    backend: str, clock: FakeClock, fake: FakeRedis
) -> InMemorySessionStore | RedisSessionStore:
    if backend == "memory":
        return InMemorySessionStore(clock)
    return RedisSessionStore(cast("Redis", fake))


def _graceful(store: InMemorySessionStore | RedisSessionStore, clock: FakeClock) -> SessionManager:
    return SessionManager(
        store=store,
        clock=clock,
        idle_ttl_seconds=IDLE,
        absolute_ttl_seconds=ABSOLUTE,
        rotate_after_seconds=ROTATE,
        rotation_grace_seconds=GRACE,
    )


async def _rotate(manager: SessionManager, token: str, clock: FakeClock) -> str:
    clock.now += ROTATE
    loaded = await manager.load(token)
    assert loaded is not None
    rotated = await manager.rotate_if_due(loaded)
    assert rotated is not None
    return rotated.token


@pytest.mark.parametrize("backend", ["memory", "redis"])
async def test_rotated_token_resolves_during_grace_without_rotating_again(
    clock: FakeClock, backend: str
) -> None:
    fake = FakeRedis()
    store = _store(backend, clock, fake)
    manager = _graceful(store, clock)
    old, data = await _create(manager)
    new = await _rotate(manager, old, clock)
    tombstone = RotatedTombstone(hash_token(new))
    assert await store.get(hash_token(old)) == tombstone
    if isinstance(store, RedisSessionStore):
        assert fake.data[f"mm:sess:{hash_token(old)}"] == tombstone.to_json()
        assert fake.ttls[f"mm:sess:{hash_token(old)}"] == GRACE

    clock.now += GRACE - 1
    loaded = await manager.load(old)
    assert loaded is not None
    assert loaded.via_tombstone
    assert loaded.data.csrf_token == data.csrf_token
    assert await manager.rotate_if_due(loaded) is None  # never rotated twice
    assert await manager.peek(old) == loaded.data
    assert await manager.load(new) is not None

    if isinstance(store, InMemorySessionStore):
        clock.now += 1
        assert await manager.load(old) is None  # grace over
        assert await manager.load(new) is not None


@pytest.mark.parametrize("backend", ["memory", "redis"])
async def test_parallel_rotation_of_the_same_token_does_not_fork(
    clock: FakeClock, backend: str
) -> None:
    fake = FakeRedis()
    store = _store(backend, clock, fake)
    manager = _graceful(store, clock)
    old, _ = await _create(manager)
    clock.now += ROTATE
    first = await manager.load(old)
    second = await manager.load(old)  # loaded before either request rotated
    assert first is not None
    assert second is not None
    rotated = await manager.rotate_if_due(first)
    assert rotated is not None
    assert await manager.rotate_if_due(second) is None  # served, no second live record
    assert await store.get(hash_token(old)) == RotatedTombstone(hash_token(rotated.token))
    if isinstance(store, InMemorySessionStore):
        assert len(store) == 2  # tombstone + one live record


@pytest.mark.parametrize("backend", ["memory", "redis"])
@pytest.mark.parametrize("revoke_with", ["old", "new"])
async def test_revoking_either_token_kills_both(
    clock: FakeClock, backend: str, revoke_with: str
) -> None:
    fake = FakeRedis()
    store = _store(backend, clock, fake)
    manager = _graceful(store, clock)
    old, _ = await _create(manager)
    new = await _rotate(manager, old, clock)
    await manager.revoke(old if revoke_with == "old" else new)
    assert await manager.load(old) is None
    assert await manager.load(new) is None
    if revoke_with == "old":  # the tombstone and the live record go together
        assert await store.get(hash_token(old)) is None
        assert await store.get(hash_token(new)) is None


async def test_tombstones_are_followed_one_hop_only(
    store: InMemorySessionStore, clock: FakeClock
) -> None:
    manager = SessionManager(
        store=store,
        clock=clock,
        idle_ttl_seconds=IDLE,
        absolute_ttl_seconds=ABSOLUTE,
        rotate_after_seconds=10,
        rotation_grace_seconds=300,
    )

    async def rotate(token: str) -> str:
        clock.now += 10
        loaded = await manager.load(token)
        assert loaded is not None
        rotated = await manager.rotate_if_due(loaded)
        assert rotated is not None
        return rotated.token

    first, _ = await _create(manager)
    second = await rotate(first)
    third = await rotate(second)  # first's tombstone (-> second) is still within its grace
    assert isinstance(await store.get(hash_token(first)), RotatedTombstone)
    assert await manager.load(third) is not None
    assert await manager.load(second) is not None
    assert await manager.load(first) is None  # would need two hops
    assert await manager.peek(first) is None


def test_malformed_tombstones_are_discarded() -> None:
    for raw in ('{"rotated_to":"nothex"}', '{"rotated_to":42}', '{"rotated_to":null}'):
        assert session_module._decode(raw) is None
    good = RotatedTombstone("a" * 64)
    assert session_module._decode(good.to_json()) == good


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
        (
            "EVAL",
            ROTATE_SESSION_LUA,
            2,
            key,
            new_key,
            rotated.data.to_json(),
            str(IDLE),
            json.dumps({"rotated_to": hash_token(rotated.token)}, separators=(",", ":")),
            "0",
        ),
    ]
    assert key not in fake.data  # no grace configured: the old key is deleted
    assert fake.ttls[new_key] == IDLE

    fake.commands.clear()
    await manager.revoke(rotated.token)
    assert fake.commands == [("GET", new_key), ("DEL", new_key)]


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
        await store.replace("abc", "def", data, 10, 0)


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


@pytest.mark.integration
@pytest.mark.redis
async def test_real_redis_rotation_script(real_redis: Redis, clock: FakeClock) -> None:
    """ROTATE_SESSION_LUA itself (cjson tombstone detection, grace TTL, grace 0 deletes)."""
    prefix = f"mm:test:{uuid.uuid4().hex}:sess"
    store = RedisSessionStore(real_redis, prefix=prefix)
    manager = _graceful(store, clock)
    try:
        old, _ = await _create(manager)
        clock.now += ROTATE
        first = await manager.load(old)
        second = await manager.load(old)
        assert first is not None
        assert second is not None
        rotated = await manager.rotate_if_due(first)
        assert rotated is not None
        old_key = f"{prefix}:{hash_token(old)}"
        new_key = f"{prefix}:{hash_token(rotated.token)}"
        assert json.loads(await real_redis.get(old_key) or "null") == {
            "rotated_to": hash_token(rotated.token)
        }
        assert 0 < await real_redis.ttl(old_key) <= GRACE
        assert 0 < await real_redis.ttl(new_key) <= IDLE
        assert await manager.rotate_if_due(second) is None  # script returned ALREADY_ROTATED
        assert len(await real_redis.keys(f"{prefix}:*")) == 2

        via_old = await manager.load(old)
        assert via_old is not None
        assert via_old.via_tombstone

        await manager.revoke(old)  # kills the tombstone and the live successor
        assert await real_redis.exists(old_key, new_key) == 0

        # Gone: the swap writes nothing.
        data = SessionData(USER_ID, 42, "csrf", "telegram_init_data", 1, 1)
        missing = await store.replace("a" * 64, "b" * 64, data, 10, GRACE)
        assert missing is SwapResult.GONE
        assert await real_redis.exists(f"{prefix}:{'b' * 64}") == 0

        # Grace 0 deletes the old key outright.
        await store.set("c" * 64, data, 100)
        assert await store.replace("c" * 64, "d" * 64, data, 100, 0) is SwapResult.SWAPPED
        assert await real_redis.exists(f"{prefix}:{'c' * 64}") == 0
        assert await store.get("d" * 64) == data
    finally:
        keys = await real_redis.keys(f"{prefix}:*")
        if keys:
            await real_redis.delete(*keys)
