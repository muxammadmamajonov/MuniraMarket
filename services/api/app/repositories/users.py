"""User persistence behind a small interface so routes can be tested without a database."""

import uuid
from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Any, Final, Literal, Protocol

from sqlalchemy import case, func, select, update
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
    # Explicit language choice made (bot onboarding or the shop profile).
    language_confirmed: bool = False
    # Account phone verified (Telegram contact or OTP). The number itself never leaves the API.
    phone_verified: bool = False
    # Masked account phone (verified or typed in the profile) for the owner's own profile
    # (``+998 •• ••• 45 67``), else ``None``. ``phone_verified`` says whether it is verified.
    phone_hint: str | None = None
    birth_date: date | None = None


class _Unset(Enum):
    UNSET = "UNSET"


UNSET: Final = _Unset.UNSET
Unset = Literal[_Unset.UNSET]


@dataclass(frozen=True, slots=True)
class ProfileUpdate:
    """``PATCH /me``: only the keys the request contained; ``UNSET`` means "not sent"."""

    first_name: str | Unset = UNSET
    last_name: str | Unset | None = UNSET
    birth_date: date | Unset | None = UNSET
    # Normalised ``+998XXXXXXXXX``, or ``None`` to remove the phone (and its verification).
    phone: str | Unset | None = UNSET


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


def phone_hint(phone: str | None) -> str | None:
    """Only the last four digits stay readable; enough for the owner to recognise the number."""
    if phone is None:
        return None
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) < 7:
        return None
    if digits.startswith("998") and len(digits) == 12:
        return f"+998 •• ••• {digits[-4:-2]} {digits[-2:]}"
    return "+" + "•" * (len(digits) - 4) + " " + digits[-4:]


_PHONE_DIGITS_MIN = 7
_PHONE_DIGITS_MAX = 15


def normalize_contact_phone(raw: str) -> str | None:
    """E.164 ``+<digits>`` from a Telegram contact number (``998901234567``, ``+998 90 ...``)."""
    stripped = raw.strip()
    digits = "".join(ch for ch in stripped if ch.isdigit())
    allowed = set("0123456789+ -()")
    if not stripped or any(ch not in allowed for ch in stripped) or "+" in stripped[1:]:
        return None
    if not _PHONE_DIGITS_MIN <= len(digits) <= _PHONE_DIGITS_MAX or digits.startswith("0"):
        return None
    return f"+{digits}"


class UserRepository(Protocol):
    async def upsert_from_telegram(self, profile: TelegramProfile) -> UserRecord: ...

    async def get_by_telegram_id(self, telegram_user_id: int) -> UserRecord | None: ...

    async def get_by_id(self, user_id: uuid.UUID) -> UserRecord | None: ...

    async def set_language(self, user_id: uuid.UUID, language: Language) -> UserRecord | None: ...

    async def record_telegram_phone(
        self, telegram_user_id: int, phone: str
    ) -> UserRecord | None: ...

    async def update_profile(
        self, user_id: uuid.UUID, changes: ProfileUpdate
    ) -> UserRecord | None: ...


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
        language_confirmed=user.language_confirmed_at is not None,
        phone_verified=user.phone_verified_at is not None,
        phone_hint=phone_hint(user.phone),
        birth_date=user.birth_date,
    )


class SqlAlchemyUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert_from_telegram(self, profile: TelegramProfile) -> UserRecord:
        """Insert or refresh the user in one atomic statement and commit.

        The language is taken from Telegram only when a user is first created, so a language the
        user later picks inside the shop is not overwritten on every sign-in. Likewise the name:
        once the user edited it in the shop (``name_edited_at``), Telegram no longer overwrites
        ``first_name`` / ``last_name``; ``username`` is always refreshed.
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
                "first_name": case(
                    (User.name_edited_at.is_(None), insert_stmt.excluded.first_name),
                    else_=User.first_name,
                ),
                "last_name": case(
                    (User.name_edited_at.is_(None), insert_stmt.excluded.last_name),
                    else_=User.last_name,
                ),
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

    async def set_language(self, user_id: uuid.UUID, language: Language) -> UserRecord | None:
        """The one write path for the language preference (bot and shop). Marks it confirmed."""
        statement = (
            update(User)
            .where(User.id == user_id)
            .values(language=language, language_confirmed_at=func.now(), updated_at=func.now())
            .returning(User)
        )
        user = (await self._session.execute(statement)).scalar_one_or_none()
        record = _to_record(user) if user else None
        await self._session.commit()
        return record

    async def record_telegram_phone(self, telegram_user_id: int, phone: str) -> UserRecord | None:
        """Store the user's own Telegram contact number as their verified account phone."""
        statement = (
            update(User)
            .where(User.telegram_user_id == telegram_user_id)
            .values(
                phone=phone,
                phone_verified_at=func.now(),
                phone_verification_method="telegram_contact",
                updated_at=func.now(),
            )
            .returning(User)
        )
        user = (await self._session.execute(statement)).scalar_one_or_none()
        record = _to_record(user) if user else None
        await self._session.commit()
        return record

    async def update_profile(self, user_id: uuid.UUID, changes: ProfileUpdate) -> UserRecord | None:
        """Apply ``PATCH /me`` in one atomic UPDATE and commit.

        Writing either name part marks the name as user-edited. A phone equal to the stored one
        changes nothing (its verification is kept); a different number is stored unverified;
        ``None`` removes the phone and its verification. Every ``CASE`` reads the row as it was
        before this statement.
        """
        values: dict[str, Any] = {"updated_at": func.now()}
        if changes.first_name is not UNSET:
            values["first_name"] = changes.first_name
        if changes.last_name is not UNSET:
            values["last_name"] = changes.last_name
        if changes.first_name is not UNSET or changes.last_name is not UNSET:
            values["name_edited_at"] = func.now()
        if changes.birth_date is not UNSET:
            values["birth_date"] = changes.birth_date
        if changes.phone is not UNSET:
            if changes.phone is None:
                values.update(phone=None, phone_verified_at=None, phone_verification_method=None)
            else:
                same = User.phone == changes.phone
                values.update(
                    phone=changes.phone,
                    phone_verified_at=case((same, User.phone_verified_at), else_=None),
                    phone_verification_method=case(
                        (same, User.phone_verification_method), else_=None
                    ),
                )
        statement = update(User).where(User.id == user_id).values(**values).returning(User)
        user = (
            await self._session.execute(statement, execution_options={"populate_existing": True})
        ).scalar_one_or_none()
        record = _to_record(user) if user else None
        await self._session.commit()
        return record
