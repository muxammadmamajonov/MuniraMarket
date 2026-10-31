"""Notification outbox routes (ADR 0008) against a fake repository: signed service requests only."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI

from app.api.routes import internal_notifications as routes
from app.repositories.outbox import OutboxMessage, ReportedOutcome, retry_delay
from tests.conftest import NOW
from tests.test_service_auth import signed_headers

CLAIM = "/api/v1/internal/telegram/notifications/claim"
MESSAGE_ID = uuid.uuid4()


def result_path(message_id: uuid.UUID) -> str:
    return f"/api/v1/internal/telegram/notifications/{message_id}/result"


class FakeOutboxRepository:
    def __init__(self) -> None:
        self.messages = [
            OutboxMessage(
                id=MESSAGE_ID,
                event_type="order.status_changed",
                payload={"order_number": "261031-ABCDEF", "status": "NEW", "chat_id": 555},
                attempts=1,
            )
        ]
        self.claims: list[tuple[int, datetime]] = []
        self.reports: list[tuple[uuid.UUID, ReportedOutcome, int, str | None, datetime]] = []

    async def claim(self, *, limit: int, now: datetime) -> list[OutboxMessage]:
        self.claims.append((limit, now))
        return self.messages[:limit]

    async def report(
        self,
        message_id: uuid.UUID,
        outcome: ReportedOutcome,
        *,
        attempt: int,
        error_code: str | None,
        now: datetime,
    ) -> bool:
        self.reports.append((message_id, outcome, attempt, error_code, now))
        return message_id == MESSAGE_ID


@pytest.fixture
def outbox(app: FastAPI) -> FakeOutboxRepository:
    repository = FakeOutboxRepository()
    app.dependency_overrides[routes.get_outbox_repository] = lambda: repository
    return repository


_counter = iter(range(10**6))


def service_headers(method: str, path: str, body: bytes = b"", actor: str = "") -> dict[str, str]:
    return signed_headers(
        method=method,
        path=path,
        body=body,
        actor=actor,
        nonce=f"nonce-outbox-{next(_counter):010d}",
    )


def as_json(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


async def test_claim(client: httpx.AsyncClient, outbox: FakeOutboxRepository) -> None:
    body = as_json({"limit": 5})
    response = await client.post(CLAIM, content=body, headers=service_headers("POST", CLAIM, body))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    now = datetime.fromtimestamp(NOW, tz=UTC)
    assert response.json() == {
        "items": [
            {
                "id": str(MESSAGE_ID),
                "event_type": "order.status_changed",
                "payload": {"order_number": "261031-ABCDEF", "status": "NEW", "chat_id": 555},
                "attempts": 1,
            }
        ],
        "lease_expires_at": (now + timedelta(seconds=60)).isoformat().replace("+00:00", "Z"),
    }
    assert outbox.claims == [(5, now)]


async def test_claim_with_an_empty_body_uses_the_default_limit(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository
) -> None:
    response = await client.post(CLAIM, headers=service_headers("POST", CLAIM))
    assert response.status_code == 200
    assert outbox.claims[0][0] == 20


@pytest.mark.parametrize(
    "payload", [{"limit": 0}, {"limit": 51}, {"limit": "x"}, {"limit": 5, "extra": 1}]
)
async def test_claim_validates_after_the_signature(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository, payload: dict[str, object]
) -> None:
    body = as_json(payload)
    response = await client.post(CLAIM, content=body, headers=service_headers("POST", CLAIM, body))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert outbox.claims == []


@pytest.mark.parametrize("outcome", ["delivered", "recipient_blocked", "retry", "failed"])
async def test_report(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository, outcome: str
) -> None:
    path = result_path(MESSAGE_ID)
    body = as_json({"attempt": 3, "outcome": outcome, "error_code": "bot_api_429"})
    response = await client.post(path, content=body, headers=service_headers("POST", path, body))
    assert response.status_code == 204
    assert outbox.reports == [
        (MESSAGE_ID, outcome, 3, "bot_api_429", datetime.fromtimestamp(NOW, tz=UTC))
    ]


async def test_report_unknown_message_is_404(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository
) -> None:
    other = uuid.uuid4()
    path = result_path(other)
    body = as_json({"attempt": 1, "outcome": "delivered"})
    response = await client.post(path, content=body, headers=service_headers("POST", path, body))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert outbox.reports[0][0] == other


@pytest.mark.parametrize(
    "payload",
    [
        {"outcome": "lost"},
        {},
        {"outcome": "retry", "error_code": "Has Spaces"},
        {"outcome": "retry", "error_code": "x" * 65},
        {"outcome": "retry", "message": "free text"},
    ],
)
async def test_report_validation(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository, payload: dict[str, object]
) -> None:
    path = result_path(MESSAGE_ID)
    body = as_json(payload)
    response = await client.post(path, content=body, headers=service_headers("POST", path, body))
    assert response.status_code == 422
    assert outbox.reports == []


async def test_unsigned_requests_get_401_and_learn_nothing(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository
) -> None:
    path = result_path(MESSAGE_ID)
    for response in (
        await client.post(CLAIM, json={"limit": 5}),
        await client.post(CLAIM, json={"limit": 999}),  # invalid body: still 401, not 422
        await client.post(path, json={"outcome": "delivered"}),
    ):
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"
    # A signature over another body is rejected too.
    signed = service_headers("POST", CLAIM, as_json({"limit": 1}))
    response = await client.post(CLAIM, content=as_json({"limit": 50}), headers=signed)
    assert response.status_code == 401
    assert outbox.claims == []
    assert outbox.reports == []


async def test_requests_acting_for_a_user_are_refused(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository
) -> None:
    path = result_path(MESSAGE_ID)
    body = as_json({"attempt": 1, "outcome": "delivered"})
    for response in (
        await client.post(CLAIM, headers=service_headers("POST", CLAIM, actor="tg:123456789")),
        await client.post(
            path, content=body, headers=service_headers("POST", path, body, actor="tg:123456789")
        ),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
    assert outbox.claims == []
    assert outbox.reports == []


async def test_report_path_must_be_a_uuid(
    client: httpx.AsyncClient, outbox: FakeOutboxRepository
) -> None:
    path = "/api/v1/internal/telegram/notifications/nope/result"
    body = as_json({"attempt": 1, "outcome": "delivered"})
    response = await client.post(path, content=body, headers=service_headers("POST", path, body))
    assert response.status_code == 422
    assert outbox.reports == []


def test_retry_delay_schedule() -> None:
    assert [retry_delay(n).total_seconds() for n in range(1, 10)] == [
        30,
        60,
        120,
        240,
        480,
        960,
        1920,
        3600,
        3600,
    ]
    assert retry_delay(0) == timedelta(seconds=30)
