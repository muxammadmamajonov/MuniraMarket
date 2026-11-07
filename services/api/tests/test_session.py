"""Session store and policy (sliding idle TTL, absolute lifetime, rotation)."""

import hashlib
import json
import uuid

import pytest

from app.security import session as session_module
from app.security.session import (
    InMemorySessionStore,
    RotatedTombstone,
    SessionData,
    SessionGoneError,
    SessionManager,
    SessionStore,
    hash_token,
    is_well_formed_token,
    new_token,
)
from tests.conftest import NOW, FakeClock

DAY = 86400
IDLE = 7 * DAY
ABSOLUTE = 30 * DAY
ROTATE = DAY
USER_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")


def _manager(store: SessionStore, clock: FakeClock) -> SessionManager:
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
    data = SessionData(USER_ID, 42, "csrf", "telegram_oidc", 10, 20, "admin")
    assert SessionData.from_json(data.to_json()) == data
    assert json.loads(data.to_json()) == {
        "user_id": str(USER_ID),
        "telegram_user_id": 42,
        "csrf_token": "csrf",
        "auth_method": "telegram_oidc",
        "created_at": 10,
        "last_rotated_at": 20,
        "entrance": "admin",
    }
    good = json.loads(data.to_json())
    for broken in (
        "[]",
        "not json",
        json.dumps({**good, "auth_method": "password"}),
        json.dumps({**good, "auth_method": "telegram_login_widget"}),
        json.dumps({**good, "entrance": "internal"}),
        json.dumps({k: v for k, v in good.items() if k != "entrance"}),
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


async def test_rotation_never_resurrects_a_revoked_session(clock: FakeClock) -> None:
    store = InMemorySessionStore(clock)
    manager = _manager(store, clock)
    token, _ = await _create(manager)
    clock.now += ROTATE
    loaded = await manager.load(token)
    assert loaded is not None
    await manager.revoke(token)  # concurrent logout / block between load and rotation
    with pytest.raises(SessionGoneError):
        await manager.rotate_if_due(loaded)
    assert len(store) == 0


async def test_touch_never_recreates_a_deleted_session(
    store: InMemorySessionStore, manager: SessionManager
) -> None:
    token, _ = await _create(manager)
    await manager.revoke(token)
    assert await store.expire(hash_token(token), IDLE) is False
    assert len(store) == 0


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


def _graceful(store: SessionStore, clock: FakeClock) -> SessionManager:
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


async def test_rotated_token_resolves_during_grace_without_rotating_again(clock: FakeClock) -> None:
    store = InMemorySessionStore(clock)
    manager = _graceful(store, clock)
    old, data = await _create(manager)
    new = await _rotate(manager, old, clock)
    tombstone = RotatedTombstone(hash_token(new))
    assert await store.get(hash_token(old)) == tombstone

    clock.now += GRACE - 1
    loaded = await manager.load(old)
    assert loaded is not None
    assert loaded.via_tombstone
    assert loaded.data.csrf_token == data.csrf_token
    assert await manager.rotate_if_due(loaded) is None  # never rotated twice
    assert await manager.peek(old) == loaded.data
    assert await manager.load(new) is not None

    clock.now += 1
    assert await manager.load(old) is None  # grace over
    assert await manager.load(new) is not None


async def test_parallel_rotation_of_the_same_token_does_not_fork(clock: FakeClock) -> None:
    store = InMemorySessionStore(clock)
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
    assert len(store) == 2  # tombstone + one live record


@pytest.mark.parametrize("revoke_with", ["old", "new"])
async def test_revoking_either_token_kills_both(clock: FakeClock, revoke_with: str) -> None:
    store = InMemorySessionStore(clock)
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
