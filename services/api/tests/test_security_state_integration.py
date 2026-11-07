"""PostgreSQL-backed security state (ADR 0013) against a real, migrated schema.

What Redis used to guarantee must still hold under concurrency: a session is never forked or
resurrected by rotation, a rate-limit hit is never lost, a service nonce is accepted once, an OIDC
state is consumed once; expiry is exact without the cleanup job, which only reclaims space.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import httpx
import pytest_asyncio
from sqlalchemy import func, select, text

from app.audit import AuditEntity
from app.models.audit import AuditLog
from app.models.enums import UserRole
from app.models.notification import StaffNotificationChat
from app.models.security_state import (
    AuthSession,
    OidcLoginState,
    RateLimitCounter,
    ServiceRequestNonce,
)
from app.repositories.security_state import delete_expired
from app.security.oidc_state import PendingLogin, PostgresOidcStateStore
from app.security.rate_limit import PostgresRateLimiter
from app.security.service_auth import PostgresNonceStore
from app.security.session import (
    PostgresSessionStore,
    RotatedTombstone,
    SessionData,
    SessionGoneError,
    SessionManager,
    SwapResult,
    hash_token,
)
from tests.conftest import NOW, FakeClock
from tests.db_data import SessionFactory, add_user, build_app
from tests.db_support import INTEGRATION_MARKS
from tests.test_service_auth import signed_headers

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS

DAY = 86400
USER_ID = uuid.UUID("00000000-0000-4000-8000-0000000000aa")


@pytest_asyncio.fixture(loop_scope="module")
async def factory(session_factory: SessionFactory) -> SessionFactory:
    return session_factory


def manager(store: PostgresSessionStore, clock: FakeClock, grace: int = 60) -> SessionManager:
    return SessionManager(
        store=store,
        clock=clock,
        idle_ttl_seconds=7 * DAY,
        absolute_ttl_seconds=30 * DAY,
        rotate_after_seconds=DAY,
        rotation_grace_seconds=grace,
    )


async def rows(factory: SessionFactory, model: type[object]) -> int:
    async with factory() as session:
        return int((await session.execute(select(func.count()).select_from(model))).scalar_one())


# --- sessions -----------------------------------------------------------------------------------


async def test_session_lifecycle_stores_only_the_hash(factory: SessionFactory) -> None:
    clock = FakeClock()
    sessions = manager(PostgresSessionStore(factory, clock), clock)
    issued = await sessions.create(
        user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc", entrance="admin"
    )
    async with factory() as session:
        stored = (await session.execute(select(AuthSession))).scalar_one()
    assert stored.token_hash == hash_token(issued.token)
    assert issued.token not in json.dumps(stored.record)
    assert stored.user_id == USER_ID
    assert stored.record["entrance"] == "admin"
    assert stored.expires_at == datetime.fromtimestamp(NOW + 7 * DAY, UTC)

    clock.now += 10
    loaded = await sessions.load(issued.token)
    assert loaded is not None
    assert loaded.data == issued.data
    await sessions.revoke(issued.token)
    assert await sessions.load(issued.token) is None
    assert await rows(factory, AuthSession) == 0


async def test_expired_rows_are_invisible_without_cleanup(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    sessions = manager(store, clock)
    issued = await sessions.create(
        user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc"
    )
    clock.now += 7 * DAY + 1  # idle expiry passed; the row still exists
    assert await rows(factory, AuthSession) == 1
    assert await sessions.load(issued.token) is None
    assert await store.expire(hash_token(issued.token), 60) is False  # never revived


async def test_parallel_rotation_never_forks_the_session(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    sessions = manager(store, clock)
    issued = await sessions.create(
        user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc"
    )
    clock.now += DAY
    loaded = [await sessions.load(issued.token) for _ in range(8)]
    assert all(item is not None for item in loaded)
    results = await asyncio.gather(
        *(sessions.rotate_if_due(item) for item in loaded if item is not None)
    )
    winners = [result for result in results if result is not None]
    assert len(winners) == 1  # one request rotated; the others were served without a cookie
    assert await store.get(hash_token(issued.token)) == RotatedTombstone(
        hash_token(winners[0].token)
    )
    async with factory() as session:
        live = (
            await session.execute(select(func.count()).where(AuthSession.user_id == USER_ID))
        ).scalar_one()
    assert live == 1  # tombstones carry no user id: exactly one live record


async def test_rotation_after_concurrent_logout_is_gone(factory: SessionFactory) -> None:
    clock = FakeClock()
    sessions = manager(PostgresSessionStore(factory, clock), clock)
    issued = await sessions.create(
        user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc"
    )
    clock.now += DAY
    loaded = await sessions.load(issued.token)
    assert loaded is not None
    await sessions.revoke(issued.token)  # logout / block between load and rotation
    try:
        await sessions.rotate_if_due(loaded)
    except SessionGoneError:
        pass
    else:  # pragma: no cover - the assertion below explains the failure
        raise AssertionError("rotation resurrected a revoked session")
    assert await rows(factory, AuthSession) == 0


async def test_logout_racing_rotation_leaves_nothing_live(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    sessions = manager(store, clock, grace=0)
    for _ in range(10):
        issued = await sessions.create(
            user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc"
        )
        clock.now += DAY
        loaded = await sessions.load(issued.token)
        assert loaded is not None

        async def rotate(item: object = loaded) -> object:
            try:
                return await sessions.rotate_if_due(item)  # type: ignore[arg-type]
            except SessionGoneError:
                return None

        rotated, _ = await asyncio.gather(rotate(), sessions.revoke(issued.token))
        # Whichever ran first, the old token is dead and at most the rotated one survives,
        # in which case a logout through it still works.
        assert await sessions.load(issued.token) is None
        if rotated is not None:
            await sessions.revoke(rotated.token)  # type: ignore[attr-defined]
        assert await rows(factory, AuthSession) == 0


async def test_replace_results(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    data = SessionData(USER_ID, 42, "csrf", "telegram_init_data", int(NOW), int(NOW))
    assert await store.replace("a" * 64, "b" * 64, data, 60, 30) is SwapResult.GONE
    await store.set("a" * 64, data, 60)
    assert await store.replace("a" * 64, "b" * 64, data, 60, 30) is SwapResult.SWAPPED
    assert await store.replace("a" * 64, "c" * 64, data, 60, 30) is SwapResult.ALREADY_ROTATED
    assert await store.get("c" * 64) is None


async def test_malformed_records_are_discarded(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    async with factory() as session:
        session.add(
            AuthSession(
                token_hash="d" * 64,
                record={"user_id": "nope"},
                expires_at=datetime.fromtimestamp(NOW + 60, UTC),
            )
        )
        await session.commit()
    assert await store.get("d" * 64) is None
    assert await rows(factory, AuthSession) == 0


async def test_revoke_user_removes_every_live_session(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresSessionStore(factory, clock)
    sessions = manager(store, clock)
    tokens = [
        (
            await sessions.create(user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc")
        ).token
        for _ in range(3)
    ]
    await store.revoke_user(USER_ID)
    assert [await sessions.load(token) for token in tokens] == [None, None, None]


# --- rate limits ----------------------------------------------------------------------------------


async def test_concurrent_hits_are_counted_exactly(factory: SessionFactory) -> None:
    clock = FakeClock(NOW + 5)
    limiter = PostgresRateLimiter(factory, clock)
    decisions = await asyncio.gather(
        *(limiter.hit("auth_login", "203.0.113.7", limit=10, window_seconds=60) for _ in range(25))
    )
    assert sum(decision.allowed for decision in decisions) == 10
    async with factory() as session:
        counter = (await session.execute(select(RateLimitCounter))).scalar_one()
    assert counter.hits == 25
    assert counter.bucket == f"auth_login:203.0.113.7:{int(NOW)}"
    assert counter.expires_at == datetime.fromtimestamp(NOW + 120, UTC)
    # The next window starts from zero.
    clock.now = NOW + 60
    assert (await limiter.hit("auth_login", "203.0.113.7", limit=10, window_seconds=60)).allowed


# --- service-request nonces -----------------------------------------------------------------------


async def test_a_nonce_is_accepted_once_even_concurrently(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresNonceStore(factory, clock)
    results = await asyncio.gather(*(store.register("k", "n" * 16, 660) for _ in range(10)))
    assert results.count(True) == 1
    assert await store.register("other", "n" * 16, 660)  # scoped per key id
    clock.now += 659
    assert not await store.register("k", "n" * 16, 660)
    clock.now += 2  # the replay window is over: the nonce may be reused
    assert await store.register("k", "n" * 16, 660)


# --- OIDC login states ----------------------------------------------------------------------------


def pending(entrance: str = "storefront") -> PendingLogin:
    return PendingLogin(
        binding_hash="b" * 64,
        entrance="admin" if entrance == "admin" else "storefront",
        code_verifier="v" * 86,
        nonce="nonce-value",
        return_to="/uz",
        created_at=int(NOW),
    )


async def test_oidc_state_is_consumed_exactly_once(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresOidcStateStore(factory, clock)
    await store.put("s" * 64, pending("admin"), 600)
    results = await asyncio.gather(*(store.take("s" * 64) for _ in range(5)))
    taken = [result for result in results if result is not None]
    assert taken == [pending("admin")]
    assert await rows(factory, OidcLoginState) == 0


async def test_expired_oidc_state_is_refused(factory: SessionFactory) -> None:
    clock = FakeClock()
    store = PostgresOidcStateStore(factory, clock)
    await store.put("t" * 64, pending(), 600)
    clock.now += 601
    assert await store.take("t" * 64) is None


# --- cleanup --------------------------------------------------------------------------------------


async def test_cleanup_removes_only_expired_rows(factory: SessionFactory) -> None:
    clock = FakeClock()
    sessions = manager(PostgresSessionStore(factory, clock), clock)
    limiter = PostgresRateLimiter(factory, clock)
    nonces = PostgresNonceStore(factory, clock)
    states = PostgresOidcStateStore(factory, clock)
    old = await sessions.create(user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc")
    await limiter.hit("s", "a", limit=1, window_seconds=60)
    await nonces.register("k", "old-nonce-000000", 660)
    await states.put("o" * 64, pending(), 600)
    clock.now += 8 * DAY
    fresh = await sessions.create(user_id=USER_ID, telegram_user_id=42, auth_method="telegram_oidc")
    await nonces.register("k", "new-nonce-000000", 660)

    async with factory() as session:
        removed = await delete_expired(session, now=datetime.fromtimestamp(clock.now, UTC))
    assert removed == {
        "auth_sessions": 1,
        "rate_limit_counters": 1,
        "service_request_nonces": 1,
        "oidc_login_states": 1,
    }
    assert await sessions.load(old.token) is None
    assert await sessions.load(fresh.token) is not None
    assert await rows(factory, ServiceRequestNonce) == 1


async def test_cleanup_route_is_signed_service_only(factory: SessionFactory) -> None:
    clock = FakeClock()
    app = build_app(factory, clock=clock)
    path = "/api/v1/internal/maintenance/cleanup"
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post(path)).status_code == 401
        as_user = await client.post(path, headers=signed_headers(method="POST", path=path))
        assert as_user.status_code == 403  # a user actor is never allowed
        ok = await client.post(
            path,
            headers=signed_headers(
                method="POST", path=path, actor="", nonce="nonce-cleanup-000001"
            ),
        )
        assert ok.status_code == 204


# --- staff group (/connect_orders) ----------------------------------------------------------------

CONNECT = "/api/v1/internal/telegram/staff-chat/connect"


async def _connect(
    client: httpx.AsyncClient, telegram_id: int, chat_id: int, nonce: str
) -> httpx.Response:
    body = json.dumps({"chat_id": chat_id, "chat_type": "supergroup"}).encode()
    return await client.post(
        CONNECT,
        content=body,
        headers=signed_headers(
            method="POST", path=CONNECT, body=body, actor=f"tg:{telegram_id}", nonce=nonce
        ),
    )


async def test_only_an_admin_can_connect_the_staff_group(factory: SessionFactory) -> None:
    clock = FakeClock()
    admin = await add_user(factory, 5550001, role=UserRole.ADMIN)
    await add_user(factory, 5550002, role=UserRole.OPERATOR)
    await add_user(factory, 5550003)
    app = build_app(factory, clock=clock)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for index, telegram_id in enumerate((5550002, 5550003, 999)):
            response = await _connect(
                client, telegram_id, -100777, f"nonce-connect-deny-{index:02d}"
            )
            assert response.status_code == 403
        async with factory() as session:
            assert (await session.execute(select(StaffNotificationChat))).first() is None

        ok = await _connect(client, 5550001, -1001234567890, "nonce-connect-ok-000001")
        assert ok.status_code == 200
        assert ok.json() == {"connected": True}
        again = await _connect(client, 5550001, -1009999999999, "nonce-connect-ok-000002")
        assert again.status_code == 200

        private_chat = json.dumps({"chat_id": 5550001, "chat_type": "private"}).encode()
        refused = await client.post(
            CONNECT,
            content=private_chat,
            headers=signed_headers(
                method="POST",
                path=CONNECT,
                body=private_chat,
                actor="tg:5550001",
                nonce="nonce-connect-bad-00001",
            ),
        )
        assert refused.status_code == 422
        unsigned = await client.post(CONNECT, json={"chat_id": -1, "chat_type": "group"})
        assert unsigned.status_code == 401

    async with factory() as session:
        [chat] = (await session.execute(select(StaffNotificationChat))).scalars().all()
        assert (chat.id, chat.chat_id, chat.connected_by_user_id) == (1, -1009999999999, admin.id)
        audit = (
            (
                await session.execute(
                    select(AuditLog).where(AuditLog.entity_type == AuditEntity.STAFF_CHAT)
                )
            )
            .scalars()
            .all()
        )
        assert [entry.action for entry in audit] == ["staff_chat.connect"] * 2
        assert all("chat_id" not in json.dumps(entry.details) for entry in audit)
        assert (
            await session.execute(text("SELECT count(*) FROM staff_notification_chat"))
        ).scalar_one() == 1
