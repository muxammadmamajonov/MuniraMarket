"""User persistence behind a small interface so routes can be tested without a database."""

import uuid
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import Language, UserRole
from app.models.user import User


@dataclass(frozen=True, slots=True)
class UserRecord:
    id: uuid.UUID
    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language: Language
    role: UserRole
    is_blocked: bool


@dataclass(frozen=True, slots=True)
class TelegramProfile:
    telegram_user_id: int
    first_name: str
    last_name: str | None = None
    username: str | None = None
    language_code: str | None = None


def language_from_code(language_code: str | None) -> Language | None:
    """Map a Telegram ``language_code`` to a supported language, else ``None``."""
    if language_code is None:
        return None
    primary = language_code.lower().split("-", 1)[0]
    try:
        return Language(primary)
    except ValueError:
        return None


class UserRepository(Protocol):
    async def upsert_from_telegram(self, profile: TelegramProfile) -> UserRecord: ...

    async def get_by_telegram_id(self, telegram_user_id: int) -> UserRecord | None: ...

    async def get_by_id(self, user_id: uuid.UUID) -> UserRecord | None: ...


def _to_record(user: User) -> UserRecord:
    return UserRecord(
        id=user.id,
        telegram_user_id=user.telegram_user_id,
        first_name=user.first_name,
        last_name=user.last_name,
        username=user.username,
        language=user.language,
        role=user.role,
        is_blocked=user.is_blocked,
    )


class SqlAlchemyUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert_from_telegram(self, profile: TelegramProfile) -> UserRecord:
        """Insert or refresh the user in one atomic statement and commit.

        The language is taken from Telegram only when a user is first created, so a language the
        user later picks inside the shop is not overwritten on every sign-in.
        """
        language = language_from_code(profile.language_code) or Language.UZ
        insert_stmt = insert(User).values(
            telegram_user_id=profile.telegram_user_id,
            first_name=profile.first_name,
            last_name=profile.last_name,
            username=profile.username,
            language=language,
        )
        statement = insert_stmt.on_conflict_do_update(
            index_elements=[User.telegram_user_id],
            set_={
                "first_name": insert_stmt.excluded.first_name,
                "last_name": insert_stmt.excluded.last_name,
                "username": insert_stmt.excluded.username,
                "updated_at": func.now(),
            },
        ).returning(User)
        user = (await self._session.execute(statement)).scalar_one()
        record = _to_record(user)
        await self._session.commit()
        return record

    async def get_by_telegram_id(self, telegram_user_id: int) -> UserRecord | None:
        result = await self._session.execute(
            select(User).where(User.telegram_user_id == telegram_user_id)
        )
        user = result.scalar_one_or_none()
        return _to_record(user) if user else None

    async def get_by_id(self, user_id: uuid.UUID) -> UserRecord | None:
        user = await self._session.get(User, user_id)
        return _to_record(user) if user else None
