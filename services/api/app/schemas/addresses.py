"""Saved delivery addresses (``/me/addresses``): request and response models.

A saved address has exactly the fields (and validation) of an order's ``DeliveryAddress`` plus an
optional ``label`` ("Home", "Work") and the ``is_default`` flag.
"""

import re
import uuid
from datetime import datetime
from typing import Annotated, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    StringConstraints,
    WithJsonSchema,
    field_validator,
)

from app.repositories.addresses import SavedAddressRecord
from app.schemas.checkout import DeliveryAddress
from app.schemas.validators import refuse_null

_CONTROL_OR_NEWLINE = re.compile(r"[\x00-\x1f\x7f]")


def _single_line(value: str) -> str:
    if _CONTROL_OR_NEWLINE.search(value):
        raise ValueError("must be a single line of text")
    return value


def _blank_to_none(value: str | None) -> str | None:
    return value or None


Label = Annotated[
    Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=0, max_length=32),
        AfterValidator(_single_line),
    ]
    | None,
    AfterValidator(_blank_to_none),
]


class SavedAddressRequest(DeliveryAddress):
    """Body of ``POST /me/addresses`` and ``PUT /me/addresses/{id}`` (a full replacement).

    ``is_default: true`` makes this the default address (the previous default is unset);
    ``false`` on the current default leaves the user without a default; omitted keeps the current
    state (a user's first address always becomes the default).
    """

    label: Label = None
    # Optional but not nullable.
    is_default: Annotated[bool | None, WithJsonSchema({"type": "boolean"})] = None

    _no_null_is_default = field_validator("is_default")(refuse_null("bool_type"))


class SavedAddress(BaseModel):
    id: uuid.UUID
    label: str | None
    lat: float
    lon: float
    street: str
    house: str
    apartment: str | None
    entrance: str | None
    floor: str | None
    landmark: str | None
    is_default: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, record: SavedAddressRecord) -> Self:
        return cls(
            id=record.id,
            label=record.label,
            lat=record.lat,
            lon=record.lon,
            street=record.street,
            house=record.house,
            apartment=record.apartment,
            entrance=record.entrance,
            floor=record.floor,
            landmark=record.landmark,
            is_default=record.is_default,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class SavedAddressList(BaseModel):
    """``GET /me/addresses``: the default first, then the most recently updated."""

    items: list[SavedAddress]
