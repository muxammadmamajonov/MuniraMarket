import re
import uuid
from datetime import date
from typing import Annotated, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from app.domain.profile import (
    check_birth_date,
    normalize_profile_phone,
    parse_birth_date,
    tashkent_today,
)
from app.models.enums import Language, UserRole
from app.schemas.validators import refuse_null


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
    # Masked account number (last four digits) for the owner's profile; never the full number.
    # Set for any stored phone, verified or typed in the profile (see ``phone_verified``).
    phone_hint: str | None = None
    # ISO ``YYYY-MM-DD``; ``null`` until the user sets it in the shop profile.
    birth_date: date | None


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


_CONTROL_OR_NEWLINE = re.compile(r"[\x00-\x1f\x7f]")


def _single_line(value: str) -> str:
    if _CONTROL_OR_NEWLINE.search(value):
        raise ValueError("must be a single line of text")
    return value


def _blank_to_none(value: str | None) -> str | None:
    return value or None


def _birth_date_in_range(value: date) -> date:
    return check_birth_date(value, today=tashkent_today())


FirstName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64),
    AfterValidator(_single_line),
]
LastName = Annotated[
    Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=0, max_length=64),
        AfterValidator(_single_line),
    ]
    | None,
    AfterValidator(_blank_to_none),
]
BirthDate = Annotated[
    date,
    BeforeValidator(parse_birth_date),
    AfterValidator(_birth_date_in_range),
    Field(description="YYYY-MM-DD, from 1900-01-01 to today (Asia/Tashkent)"),
]
ProfilePhone = Annotated[
    str,
    StringConstraints(max_length=32),
    AfterValidator(normalize_profile_phone),
    Field(
        description=(
            "Uzbekistan number: +998XXXXXXXXX, 998XXXXXXXXX or the 9 national digits; spaces,"
            " dashes and () are ignored. Stored as +998XXXXXXXXX, unverified."
        )
    ),
]


class UpdateProfileRequest(BaseModel):
    """Body of ``PATCH /me``. Every key is optional, but at least one must be sent.

    ``first_name`` cannot be null; ``last_name``, ``birth_date`` and ``phone`` are cleared by
    ``null``. A ``phone`` different from the stored one is saved *unverified*; the same number
    keeps its verification.
    """

    model_config = ConfigDict(extra="forbid")

    # Optional but not nullable: an explicit ``null`` is refused like any non-string (the
    # schema documents the string only).
    first_name: Annotated[
        FirstName | None,
        WithJsonSchema({"type": "string", "minLength": 1, "maxLength": 64}),
    ] = None
    last_name: LastName = None
    birth_date: BirthDate | None = None
    phone: ProfilePhone | None = None

    _no_null_first_name = field_validator("first_name")(refuse_null("string_type"))

    @model_validator(mode="after")
    def _not_empty(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self
