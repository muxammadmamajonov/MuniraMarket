"""Notification outbox draining (ADR 0008) against a real PostgreSQL schema.

The repository is driven with explicit instants, so leases and backoff are tested without
sleeping; one test goes through the signed internal HTTP routes end to end.
"""

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest_asyncio
from sqlalchemy import select

from app.models.notification import NotificationOutbox
from app.repositories.outbox import (
    LEASE,
    MAX_ATTEMPTS,
    OutboxMessage,
    ReportedOutcome,
    SqlAlchemyOutboxRepository,
)
from tests.conftest import FakeClock
from tests.db_data import SessionFactory, build_app
from tests.db_support import INTEGRATION_MARKS
from tests.test_service_auth import signed_headers

pytest_plugins = ["tests.db_fixtures"]  # the engine / session_factory fixtures
pytestmark = INTEGRATION_MARKS

T0 = datetime(2030, 1, 1, 9, 0, tzinfo=UTC)


async def add_messages(
    factory: SessionFactory, count: int, *, available_at: datetime = T0
) -> list[uuid.UUID]:
    rows = [
        NotificationOutbox(
            event_type="order.status_changed",
            payload={"order_number": f"DEMO-{index:04d}", "status": "NEW"},
            created_at=T0 - timedelta(minutes=count - index),  # oldest first
            available_at=available_at,
        )
        for index in range(count)
    ]
    async with factory() as session:
        session.add_all(rows)
        await session.commit()
    return [row.id for row in rows]


async def claim(factory: SessionFactory, now: datetime, limit: int = 50) -> list[OutboxMessage]:
    async with factory() as session:
        return await SqlAlchemyOutboxRepository(session).claim(limit=limit, now=now)


async def report(
    factory: SessionFactory,
    message_id: uuid.UUID,
    outcome: ReportedOutcome,
    now: datetime,
    error_code: str | None = None,
) -> bool:
    async with factory() as session:
        return await SqlAlchemyOutboxRepository(session).report(
            message_id, outcome, error_code=error_code, now=now
        )


async def stored(factory: SessionFactory, message_id: uuid.UUID) -> NotificationOutbox:
    async with factory() as session:
        return (
            await session.execute(
                select(NotificationOutbox).where(NotificationOutbox.id == message_id)
            )
        ).scalar_one()


@pytest_asyncio.fixture(loop_scope="module")
async def factory(session_factory: SessionFactory) -> SessionFactory:
    return session_factory


# --- claiming -------------------------------------------------------------------------------------


async def test_claim_takes_due_rows_oldest_first_with_a_lease(factory: SessionFactory) -> None:
    first, second, third = await add_messages(factory, 3)
    [later] = await add_messages(factory, 1, available_at=T0 + timedelta(minutes=5))

    batch = await claim(factory, T0, limit=2)
    assert [m.id for m in batch] == [first, second]
    assert [m.attempts for m in batch] == [1, 1]
    assert batch[0].payload == {"order_number": "DEMO-0000", "status": "NEW"}
    assert (await stored(factory, first)).locked_until == T0 + LEASE

    # Inside the lease only the unclaimed due row is handed out; the future one waits.
    assert [m.id for m in await claim(factory, T0 + timedelta(seconds=10))] == [third]
    assert await claim(factory, T0 + LEASE - timedelta(seconds=1)) == []

    # Once the lease expires without a report, the rows are claimable again.
    again = await claim(factory, T0 + LEASE)
    assert [m.id for m in again] == [first, second]
    assert [m.attempts for m in again] == [2, 2]
    # The delayed row becomes due later, together with every lease that has expired by then.
    due = await claim(factory, T0 + timedelta(minutes=5))
    assert {m.id for m in due} == {first, second, third, later}
    assert {m.id: m.attempts for m in due} == {first: 3, second: 3, third: 2, later: 1}


async def test_concurrent_claims_never_return_a_row_twice(factory: SessionFactory) -> None:
    ids = await add_messages(factory, 40)
    batches = await asyncio.gather(*(claim(factory, T0, limit=5) for _ in range(10)))
    assert all(len(batch) <= 5 for batch in batches)
    claimed = [message.id for batch in batches for message in batch]
    assert len(claimed) == len(set(claimed))
    # Rows skipped because a concurrent claim held them are still available afterwards.
    rest = await claim(factory, T0, limit=50)
    everything = claimed + [message.id for message in rest]
    assert sorted(everything) == sorted(ids)
    assert all(message.attempts == 1 for message in rest)


# --- reporting ------------------------------------------------------------------------------------


async def test_delivered_finishes_the_row(factory: SessionFactory) -> None:
    [message_id] = await add_messages(factory, 1)
    await claim(factory, T0)
    done_at = T0 + timedelta(seconds=3)
    assert await report(factory, message_id, "delivered", done_at)
    row = await stored(factory, message_id)
    assert (row.outcome, row.processed_at, row.locked_until, row.last_error) == (
        "delivered",
        done_at,
        None,
        None,
    )
    # Finished rows are never handed out again, and cannot be reported twice.
    assert await claim(factory, T0 + timedelta(days=1)) == []
    assert not await report(factory, message_id, "failed", done_at)
    assert (await stored(factory, message_id)).outcome == "delivered"


async def test_recipient_blocked_and_failed_are_final(factory: SessionFactory) -> None:
    blocked, failed = await add_messages(factory, 2)
    await claim(factory, T0)
    assert await report(factory, blocked, "recipient_blocked", T0, "bot_api_403")
    assert await report(factory, failed, "failed", T0, "unknown_event")
    rows = [await stored(factory, blocked), await stored(factory, failed)]
    assert [(r.outcome, r.last_error, r.processed_at) for r in rows] == [
        ("recipient_blocked", "bot_api_403", T0),
        ("failed", "unknown_event", T0),
    ]


async def test_only_claimed_unfinished_rows_can_be_reported(factory: SessionFactory) -> None:
    [message_id] = await add_messages(factory, 1)
    assert not await report(factory, message_id, "delivered", T0)  # never claimed
    assert not await report(factory, uuid.uuid4(), "delivered", T0)  # unknown
    row = await stored(factory, message_id)
    assert (row.processed_at, row.outcome) == (None, None)


async def test_an_expired_worker_cannot_report_a_reclaimed_message(factory: SessionFactory) -> None:
    """A late result must not overwrite the worker that owns the current lease."""
    [message_id] = await add_messages(factory, 1)
    await claim(factory, T0)
    # A second worker reclaims the message once the original lease expires.
    [reclaimed] = await claim(factory, T0 + LEASE)
    assert reclaimed.id == message_id

    # The first worker's late failure cannot release or finish the second worker's lease.
    assert not await report(factory, message_id, "failed", T0 + LEASE)
    row = await stored(factory, message_id)
    assert row.locked_until == T0 + LEASE * 2
    assert (row.processed_at, row.outcome) == (None, None)

    assert await report(factory, message_id, "delivered", T0 + LEASE + timedelta(seconds=1))
    assert (await stored(factory, message_id)).outcome == "delivered"


async def test_retry_backs_off_and_releases_the_lease(factory: SessionFactory) -> None:
    [message_id] = await add_messages(factory, 1)
    await claim(factory, T0)
    failed_at = T0 + timedelta(seconds=5)
    assert await report(factory, message_id, "retry", failed_at, "bot_api_429")
    row = await stored(factory, message_id)
    assert row.available_at == failed_at + timedelta(seconds=30)
    assert (row.locked_until, row.processed_at, row.outcome) == (None, None, None)
    assert row.last_error == "bot_api_429"

    assert await claim(factory, failed_at + timedelta(seconds=29)) == []
    [again] = await claim(factory, failed_at + timedelta(seconds=30))
    assert again.attempts == 2
    second_failure = failed_at + timedelta(seconds=31)
    assert await report(factory, message_id, "retry", second_failure)
    assert (await stored(factory, message_id)).available_at == second_failure + timedelta(minutes=1)


async def test_gives_up_as_failed_after_max_attempts(factory: SessionFactory) -> None:
    [message_id] = await add_messages(factory, 1)
    now = T0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        [message] = await claim(factory, now)
        assert message.attempts == attempt
        assert await report(factory, message_id, "retry", now, "bot_api_500")
        row = await stored(factory, message_id)
        if attempt < MAX_ATTEMPTS:
            assert row.processed_at is None
            now = row.available_at
        else:
            assert (row.outcome, row.processed_at, row.attempts) == ("failed", now, MAX_ATTEMPTS)
            assert row.last_error == "bot_api_500"
    assert await claim(factory, now + timedelta(days=1)) == []


async def test_a_message_that_is_never_reported_is_retired(factory: SessionFactory) -> None:
    """A transport that crashes before reporting must not lease the same message forever."""
    [message_id] = await add_messages(factory, 1)
    now = T0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        [message] = await claim(factory, now)
        assert message.attempts == attempt
        now += LEASE  # the lease runs out without a report
    assert await claim(factory, now) == []
    row = await stored(factory, message_id)
    assert (row.outcome, row.last_error, row.locked_until) == ("failed", "max_attempts", None)


# --- over HTTP ------------------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope="module")
async def signed_client(factory: SessionFactory) -> AsyncIterator[tuple[httpx.AsyncClient, float]]:
    now = float(int(time.time()) + 3600)  # rows are due; requests are signed at this instant
    app = build_app(factory, clock=FakeClock(now))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, now


async def test_claim_and_report_over_signed_http(
    factory: SessionFactory, signed_client: tuple[httpx.AsyncClient, float]
) -> None:
    client, now = signed_client
    instant = datetime.fromtimestamp(now, tz=UTC)
    [message_id] = await add_messages(factory, 1, available_at=instant)

    path = "/api/v1/internal/telegram/notifications/claim"
    body = json.dumps({"limit": 10}).encode()
    headers = signed_headers(
        method="POST", path=path, body=body, actor="", timestamp=int(now), nonce="nonce-claim-0001"
    )
    response = await client.post(path, content=body, headers=headers)
    assert response.status_code == 200, response.text
    claimed = response.json()
    assert [item["id"] for item in claimed["items"]] == [str(message_id)]
    assert claimed["items"][0]["attempts"] == 1
    assert claimed["lease_expires_at"] == (instant + LEASE).isoformat().replace("+00:00", "Z")

    path = f"/api/v1/internal/telegram/notifications/{message_id}/result"
    body = json.dumps({"outcome": "delivered"}).encode()
    for nonce, status in (("nonce-result-0001", 204), ("nonce-result-0002", 404)):
        headers = signed_headers(
            method="POST", path=path, body=body, actor="", timestamp=int(now), nonce=nonce
        )
        response = await client.post(path, content=body, headers=headers)
        assert response.status_code == status, response.text
    row = await stored(factory, message_id)
    assert (row.outcome, row.processed_at) == ("delivered", instant)
