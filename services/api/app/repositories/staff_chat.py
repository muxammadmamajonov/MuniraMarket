"""The Telegram group that receives staff order alerts (ADR 0015).

Connecting is allowed only for a non-blocked user whose role in *this* database is ``admin``; the
Telegram Serverless bot merely relays who sent ``/connect_orders`` in which group, signed with
that user as the actor (ADR 0003). The role is read and the row written in one transaction, with
the user row locked, so a concurrent demotion cannot slip in between.
"""

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditActor, AuditEntity, record_audit
from app.models.enums import UserRole
from app.models.notification import StaffNotificationChat
from app.models.user import User

ConnectOutcome = Literal["connected", "forbidden"]
AUDIT_CONNECT = "staff_chat.connect"


@dataclass(frozen=True, slots=True)
class ConnectResult:
    outcome: ConnectOutcome


class StaffChatRepository(Protocol):
    async def connect(self, *, telegram_user_id: int, chat_id: int) -> ConnectResult: ...


class SqlAlchemyStaffChatRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def connect(self, *, telegram_user_id: int, chat_id: int) -> ConnectResult:
        try:
            user = (
                await self._session.execute(
                    select(User.id, User.role, User.is_blocked)
                    .where(User.telegram_user_id == telegram_user_id)
                    .with_for_update()
                )
            ).one_or_none()
            if user is None or user.is_blocked or user.role != UserRole.ADMIN:
                await self._session.rollback()
                return ConnectResult("forbidden")
            user_id: uuid.UUID = user.id
            statement = pg_insert(StaffNotificationChat).values(
                id=1, chat_id=chat_id, connected_by_user_id=user_id
            )
            await self._session.execute(
                statement.on_conflict_do_update(
                    index_elements=[StaffNotificationChat.id],
                    set_={
                        "chat_id": statement.excluded.chat_id,
                        "connected_by_user_id": statement.excluded.connected_by_user_id,
                        "connected_at": statement.excluded.connected_at,
                    },
                )
            )
            # The chat id is operational configuration, not personal data, but it is not needed
            # in the log either: who connected a group, and when, is what matters.
            record_audit(
                self._session,
                AuditActor(user_id=user_id, role=UserRole.ADMIN),
                action=AUDIT_CONNECT,
                entity_type=AuditEntity.STAFF_CHAT,
                entity_id="1",
            )
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise
        return ConnectResult("connected")


async def staff_chat_id(session: AsyncSession) -> int | None:
    """The connected group's chat id, read inside the caller's transaction."""
    chat_id: int | None = (
        await session.execute(select(StaffNotificationChat.chat_id))
    ).scalar_one_or_none()
    return chat_id
