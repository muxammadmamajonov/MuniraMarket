import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import UserRepositoryDep, get_identity_verifier
from app.repositories.users import TelegramProfile
from app.schemas.users import InitDataRequest, UserEnvelope, UserPublic
from app.telegram.identity import InvalidInitData, TelegramIdentityVerifier

logger = logging.getLogger("app.auth")
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/telegram/init-data", response_model=UserEnvelope)
async def authenticate_init_data(
    payload: InitDataRequest,
    verifier: Annotated[TelegramIdentityVerifier, Depends(get_identity_verifier)],
    users: UserRepositoryDep,
) -> UserEnvelope:
    """Verify Telegram Mini App ``initData`` and upsert the user.

    TODO(catalog/cart phase): issue an HTTP-only, Secure, SameSite session cookie here. Until
    then this endpoint only proves identity; it does not create a session.
    """
    try:
        identity = verifier.verify(payload.init_data)
    except InvalidInitData as exc:
        logger.info("Rejected Telegram init data: %s", exc.reason)
        raise HTTPException(status_code=401, detail="Invalid Telegram init data") from None
    user = await users.upsert_from_telegram(
        TelegramProfile(
            telegram_user_id=identity.telegram_user_id,
            first_name=identity.first_name,
            last_name=identity.last_name,
            username=identity.username,
            language_code=identity.language_code,
        )
    )
    if user.is_blocked:
        raise HTTPException(status_code=403, detail="Account is blocked")
    return UserEnvelope(user=UserPublic.model_validate(user))
