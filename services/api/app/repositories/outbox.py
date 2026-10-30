"""Notification outbox draining (ADR 0008), behind a small interface.

A transport claims a batch of due rows with a lease (``FOR UPDATE SKIP LOCKED``, so concurrent
transports never get the same row), delivers them and reports one outcome per row. A row whose
lease expires without a report becomes claimable again, so delivery is at-least-once; the payload
carries ``order_id`` + ``status`` for the transport to de-duplicate if it needs to.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, Protocol

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import NotificationOutbox

LEASE = timedelta(seconds=60)
MAX_ATTEMPTS = 8

ReportedOutcome = Literal["delivered", "recipient_blocked", "retry", "failed"]


def retry_delay(attempts: int) -> timedelta:
    """Backoff after the ``attempts``-th failure: 30 s, 1 min, 2 min, ... capped at 1 h."""
    return timedelta(seconds=min(3600, 30 * 2 ** max(0, attempts - 1)))


@dataclass(frozen=True, slots=True)
class OutboxMessage:
    id: uuid.UUID
    event_type: str
    payload: dict[str, Any]
    attempts: int


class OutboxRepository(Protocol):
    async def claim(self, *, limit: int, now: datetime) -> list[OutboxMessage]: ...

    async def report(
        self,
        message_id: uuid.UUID,
        outcome: ReportedOutcome,
        *,
        error_code: str | None,
        now: datetime,
    ) -> bool:
        """Record the outcome of a claimed, unfinished message; ``False`` if there is none."""
        ...


class SqlAlchemyOutboxRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def claim(self, *, limit: int, now: datetime) -> list[OutboxMessage]:
        due = (
            select(NotificationOutbox.id)
            .where(
                NotificationOutbox.processed_at.is_(None),
                NotificationOutbox.available_at <= now,
                or_(
                    NotificationOutbox.locked_until.is_(None),
                    NotificationOutbox.locked_until <= now,
                ),
            )
            .order_by(NotificationOutbox.created_at, NotificationOutbox.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        try:
            # A message whose delivery keeps crashing the transport before it reports is never
            # reported at all; retire it once its lease ran out at the attempt limit.
            await self._session.execute(
                update(NotificationOutbox)
                .where(
                    NotificationOutbox.processed_at.is_(None),
                    NotificationOutbox.attempts >= MAX_ATTEMPTS,
                    or_(
                        NotificationOutbox.locked_until.is_(None),
                        NotificationOutbox.locked_until <= now,
                    ),
                )
                .values(
                    processed_at=now, outcome="failed", last_error="max_attempts", locked_until=None
                )
            )
            rows = (
                await self._session.execute(
                    update(NotificationOutbox)
                    .where(NotificationOutbox.id.in_(due.scalar_subquery()))
                    .values(
                        locked_until=now + LEASE,
                        attempts=NotificationOutbox.attempts + 1,
                    )
                    .returning(
                        NotificationOutbox.id,
                        NotificationOutbox.event_type,
                        NotificationOutbox.payload,
                        NotificationOutbox.attempts,
                        NotificationOutbox.created_at,
                    )
                )
            ).all()
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise
        rows = sorted(rows, key=lambda row: (row.created_at, row.id))
        return [
            OutboxMessage(
                id=row.id, event_type=row.event_type, payload=row.payload, attempts=row.attempts
            )
            for row in rows
        ]

    async def report(
        self,
        message_id: uuid.UUID,
        outcome: ReportedOutcome,
        *,
        error_code: str | None,
        now: datetime,
    ) -> bool:
        try:
            message = (
                await self._session.execute(
                    select(NotificationOutbox)
                    .where(
                        NotificationOutbox.id == message_id,
                        NotificationOutbox.processed_at.is_(None),
                        NotificationOutbox.locked_until.is_not(None),
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if message is None:
                await self._session.rollback()
                return False
            values: dict[str, Any] = {"locked_until": None, "last_error": error_code}
            if outcome == "retry" and message.attempts < MAX_ATTEMPTS:
                values["available_at"] = now + retry_delay(message.attempts)
            else:
                final = "failed" if outcome == "retry" else outcome
                values.update(processed_at=now, outcome=final)
            await self._session.execute(
                update(NotificationOutbox)
                .where(NotificationOutbox.id == message_id)
                .values(**values)
            )
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise
        return True
