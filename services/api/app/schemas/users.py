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
