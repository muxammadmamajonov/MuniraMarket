"""The signed-in user's own profile, preferences and saved delivery addresses.

Writes need the session and the CSRF token and are limited per user (``preferences_write``).
Every response under ``/me`` is ``Cache-Control: no-store`` (``SessionCookieMiddleware``).
Addresses are looked up by id *and* the signed-in user, so another user's address is
indistinguishable from a missing one (404). Request bodies (names, phone numbers, addresses) are
never logged.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.api.auth_deps import CsrfProtectedUserDep, CurrentUserDep, rate_limit
from app.api.deps import SessionDep, UserRepositoryDep
from app.core.errors import ApiError, error_responses
from app.repositories.addresses import (
    AddressInput,
    AddressLimitReachedError,
    AddressRepository,
    SqlAlchemyAddressRepository,
)
from app.repositories.users import UNSET, ProfileUpdate
from app.schemas.addresses import SavedAddress, SavedAddressList, SavedAddressRequest
from app.schemas.users import SetLanguageRequest, UpdateProfileRequest, UserEnvelope, UserPublic
from app.security.rate_limit import PREFERENCES_WRITE

PREFERENCES_WRITE_LIMIT = rate_limit(
    PREFERENCES_WRITE.scope,
    PREFERENCES_WRITE.limit,
    PREFERENCES_WRITE.window_seconds,
    key="user",
)

router = APIRouter(prefix="/me", tags=["me"])


def get_address_repository(session: SessionDep) -> AddressRepository:
    return SqlAlchemyAddressRepository(session)


AddressRepositoryDep = Annotated[AddressRepository, Depends(get_address_repository)]


def address_not_found() -> ApiError:
    return ApiError(404, "address_not_found", "Address not found")


@router.patch(
    "",
    response_model=UserEnvelope,
    responses=error_responses(401, 403, 404, 422, 429, 503),
    dependencies=[Depends(PREFERENCES_WRITE_LIMIT)],
)
async def update_profile(
    payload: UpdateProfileRequest, user: CsrfProtectedUserDep, users: UserRepositoryDep
) -> UserEnvelope:
    """Edit the profile: name, birth date and phone. Only the keys sent are changed.

    Editing the name stops Telegram sign-ins from overwriting it. A ``phone`` different from the
    stored number is saved *unverified* (only the Telegram contact verifies a phone); the same
    number keeps its verification; ``null`` removes the phone.
    """
    sent = payload.model_fields_set
    changes = ProfileUpdate(
        # Never ``None`` when sent (the model refuses an explicit null).
        first_name=payload.first_name if payload.first_name is not None else UNSET,
        last_name=payload.last_name if "last_name" in sent else UNSET,
        birth_date=payload.birth_date if "birth_date" in sent else UNSET,
        phone=payload.phone if "phone" in sent else UNSET,
    )
    updated = await users.update_profile(user.id, changes)
    if updated is None:
        raise ApiError(404, "not_found", "User not found")
    return UserEnvelope(user=UserPublic.model_validate(updated))


@router.put(
    "/language",
    response_model=UserEnvelope,
    responses=error_responses(401, 403, 404, 422, 429, 503),
    dependencies=[Depends(PREFERENCES_WRITE_LIMIT)],
)
async def set_language(
    payload: SetLanguageRequest, user: CsrfProtectedUserDep, users: UserRepositoryDep
) -> UserEnvelope:
    """Save the storefront language. The same value the bot uses; the URL locale follows it."""
    updated = await users.set_language(user.id, payload.language)
    if updated is None:
        raise ApiError(404, "not_found", "User not found")
    return UserEnvelope(user=UserPublic.model_validate(updated))


# --- saved addresses ---------------------------------------------------------------------------


def _address_input(payload: SavedAddressRequest) -> AddressInput:
    return AddressInput(
        label=payload.label,
        lat=payload.lat,
        lon=payload.lon,
        street=payload.street,
        house=payload.house,
        apartment=payload.apartment,
        entrance=payload.entrance,
        floor=payload.floor,
        landmark=payload.landmark,
    )


def _is_default(payload: SavedAddressRequest) -> bool | None:
    return payload.is_default if "is_default" in payload.model_fields_set else None


@router.get(
    "/addresses",
    response_model=SavedAddressList,
    responses=error_responses(401, 403, 503),
)
async def list_addresses(user: CurrentUserDep, addresses: AddressRepositoryDep) -> SavedAddressList:
    """The saved addresses: the default first, then the most recently updated."""
    records = await addresses.list_for_user(user.id)
    return SavedAddressList(items=[SavedAddress.from_record(record) for record in records])


@router.post(
    "/addresses",
    response_model=SavedAddress,
    status_code=201,
    responses=error_responses(401, 403, 409, 422, 429, 503),
    dependencies=[Depends(PREFERENCES_WRITE_LIMIT)],
)
async def create_address(
    payload: SavedAddressRequest, user: CsrfProtectedUserDep, addresses: AddressRepositoryDep
) -> SavedAddress:
    """Save an address (at most 10: ``409 address_limit_reached``). The first one becomes the
    default; ``is_default: true`` moves the default to the new address."""
    try:
        record = await addresses.create(
            user.id, _address_input(payload), is_default=_is_default(payload)
        )
    except AddressLimitReachedError:
        raise ApiError(409, "address_limit_reached", "Too many saved addresses") from None
    return SavedAddress.from_record(record)


@router.put(
    "/addresses/{address_id}",
    response_model=SavedAddress,
    responses=error_responses(401, 403, 404, 422, 429, 503),
    dependencies=[Depends(PREFERENCES_WRITE_LIMIT)],
)
async def replace_address(
    address_id: uuid.UUID,
    payload: SavedAddressRequest,
    user: CsrfProtectedUserDep,
    addresses: AddressRepositoryDep,
) -> SavedAddress:
    """Replace every field of one of the user's addresses. ``is_default: true`` makes it the
    default, ``false`` (on the default) leaves the user without one, omitted keeps it."""
    record = await addresses.replace(
        user.id, address_id, _address_input(payload), is_default=_is_default(payload)
    )
    if record is None:
        raise address_not_found()
    return SavedAddress.from_record(record)


@router.delete(
    "/addresses/{address_id}",
    status_code=204,
    response_class=Response,
    responses=error_responses(401, 403, 404, 422, 429, 503),
    dependencies=[Depends(PREFERENCES_WRITE_LIMIT)],
)
async def delete_address(
    address_id: uuid.UUID, user: CsrfProtectedUserDep, addresses: AddressRepositoryDep
) -> Response:
    """Delete one of the user's addresses. Deleting the default promotes the most recently
    updated remaining address."""
    if not await addresses.delete(user.id, address_id):
        raise address_not_found()
    return Response(status_code=204)
