"""Internal routes for the Telegram Serverless bot. Signed requests only (ADR 0003)."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from app.api.deps import UserRepositoryDep, require_actor
from app.repositories.users import TelegramProfile
from app.schemas.users import TelegramSessionRequest, UserEnvelope, UserPublic

logger = logging.getLogger("app.internal.telegram")
router = APIRouter(prefix="/internal/telegram", tags=["internal"])

ActorDep = Annotated[int, Depends(require_actor)]


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
