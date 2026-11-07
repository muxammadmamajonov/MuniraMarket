import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import Language, UserRole


class UserPublic(BaseModel):
    """The only user shape exposed to clients (no phone, no internal flags)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language: Language
    role: UserRole
    # True once the user explicitly chose ``language``; until then the bot asks on ``/start``.
    language_confirmed: bool = False
    # True when the account phone is verified; needed before an order can be placed.
    phone_verified: bool = False


class UserEnvelope(BaseModel):
    user: UserPublic


class InitDataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    init_data: Annotated[str, Field(min_length=1, max_length=4096)]


class TelegramSessionRequest(BaseModel):
    """Body of ``POST /internal/telegram/session`` (sent by the signed Serverless caller)."""

    model_config = ConfigDict(extra="forbid")

    telegram_user_id: Annotated[int, Field(gt=0)]
    first_name: Annotated[str, Field(min_length=1, max_length=255)]
    last_name: Annotated[str | None, Field(max_length=255)] = None
    username: Annotated[str | None, Field(max_length=64)] = None
    language_code: Annotated[str | None, Field(max_length=16)] = None


class SetLanguageRequest(BaseModel):
    """Body of ``PUT /me/language`` and ``PUT /internal/telegram/language``."""

    model_config = ConfigDict(extra="forbid")

    language: Language


class TelegramContactRequest(BaseModel):
    """Body of ``POST /internal/telegram/phone``: the sender's own shared contact.

    The bot sends it only when the platform-verified update has ``contact.user_id == from.id``;
    the API checks ``contact_user_id`` against the signed actor again.
    """

    model_config = ConfigDict(extra="forbid")

    contact_user_id: Annotated[int, Field(gt=0)]
    phone_number: Annotated[str, Field(min_length=7, max_length=32)]
