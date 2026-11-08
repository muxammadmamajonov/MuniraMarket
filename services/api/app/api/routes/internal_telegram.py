"""Internal routes for the Telegram Serverless bot. Signed requests only (ADR 0003)."""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError

from app.api.deps import UserRepositoryDep, require_actor
from app.core.errors import ApiError
from app.repositories.users import TelegramProfile, normalize_contact_phone
from app.schemas.users import (
    SetLanguageRequest,
    TelegramContactRequest,
    TelegramSessionRequest,
    UserEnvelope,
    UserPublic,
)

logger = logging.getLogger("app.internal.telegram")
router = APIRouter(prefix="/internal/telegram", tags=["internal"])

ActorDep = Annotated[int, Depends(require_actor)]


def _request_body_schema(model: type[BaseModel]) -> dict[str, Any]:
    """OpenAPI request body for a route that validates its body by hand after the signature."""
    # Nested enums (``Language``) point at the shared component instead of local ``$defs``.
    schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
    schema.pop("$defs", None)
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": schema}},
        }
    }


async def _parse[M: BaseModel](request: Request, model: type[M]) -> M:
    try:
        return model.model_validate_json(await request.body())
    except ValidationError as exc:
        raise RequestValidationError(
            exc.errors(include_url=False, include_input=False, include_context=False)
        ) from None


@router.post(
    "/session",
    response_model=UserEnvelope,
    # The body is validated by hand *after* the signature check (see below), so FastAPI cannot
    # derive the request schema itself.
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": TelegramSessionRequest.model_json_schema(),
                }
            },
        }
    },
)
async def create_session(
    request: Request,
    actor_telegram_user_id: ActorDep,
    users: UserRepositoryDep,
) -> UserEnvelope:
    """Upsert the user the bot is acting for. The body id must equal the signed actor."""
    # Parsing the body only now keeps unauthenticated callers from learning anything about
    # body validation: a bad signature always wins and yields the generic 401.
    try:
        payload = TelegramSessionRequest.model_validate_json(await request.body())
    except ValidationError as exc:
        raise RequestValidationError(
            exc.errors(include_url=False, include_input=False, include_context=False)
        ) from None
    if payload.telegram_user_id != actor_telegram_user_id:
        raise HTTPException(status_code=403, detail="Actor does not match request body")
    user = await users.upsert_from_telegram(
        TelegramProfile(
            telegram_user_id=payload.telegram_user_id,
            first_name=payload.first_name,
            last_name=payload.last_name,
            username=payload.username,
            language_code=payload.language_code,
        )
    )
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Account is blocked")
    return UserEnvelope(user=UserPublic.model_validate(user))


@router.get("/me", response_model=UserEnvelope)
async def get_me(actor_telegram_user_id: ActorDep, users: UserRepositoryDep) -> UserEnvelope:
    user = await users.get_by_telegram_id(actor_telegram_user_id)
    if user is None or user.is_blocked:
        raise HTTPException(status_code=404, detail="User not found")
    return UserEnvelope(user=UserPublic.model_validate(user))


@router.put(
    "/language",
    response_model=UserEnvelope,
    openapi_extra=_request_body_schema(SetLanguageRequest),
)
async def set_language(
    request: Request, actor_telegram_user_id: ActorDep, users: UserRepositoryDep
) -> UserEnvelope:
    """The language the user picked in the bot's onboarding (same column as the shop profile)."""
    payload = await _parse(request, SetLanguageRequest)
    user = await users.get_by_telegram_id(actor_telegram_user_id)
    if user is None or user.is_blocked:
        raise HTTPException(status_code=404, detail="User not found")
    updated = await users.set_language(user.id, payload.language)
    if updated is None:
        raise HTTPException(status_code=404, detail="User not found")
    return UserEnvelope(user=UserPublic.model_validate(updated))


@router.post(
    "/phone",
    response_model=UserEnvelope,
    openapi_extra=_request_body_schema(TelegramContactRequest),
)
async def record_phone(
    request: Request, actor_telegram_user_id: ActorDep, users: UserRepositoryDep
) -> UserEnvelope:
    """Store the sender's OWN shared Telegram contact as the verified account phone.

    The number is never logged or returned.
    """
    payload = await _parse(request, TelegramContactRequest)
    if payload.contact_user_id != actor_telegram_user_id:
        raise HTTPException(status_code=403, detail="Only your own contact can be shared")
    phone = normalize_contact_phone(payload.phone_number)
    if phone is None:
        raise ApiError(
            422,
            "validation_error",
            "Request validation failed",
            details=[{"loc": ["body", "phone_number"], "msg": "Not a phone number"}],
        )
    user = await users.record_telegram_phone(actor_telegram_user_id, phone)
    if user is None or user.is_blocked:
        raise HTTPException(status_code=404, detail="User not found")
    logger.info("Telegram contact phone verified for user %s", user.id)
    return UserEnvelope(user=UserPublic.model_validate(user))
