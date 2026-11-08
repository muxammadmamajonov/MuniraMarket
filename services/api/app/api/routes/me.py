"""The signed-in user's own preferences. Writes need the session and the CSRF token."""

from fastapi import APIRouter, Depends

from app.api.auth_deps import CsrfProtectedUserDep, rate_limit
from app.api.deps import UserRepositoryDep
from app.core.errors import ApiError, error_responses
from app.schemas.users import SetLanguageRequest, UserEnvelope, UserPublic
from app.security.rate_limit import PREFERENCES_WRITE

PREFERENCES_WRITE_LIMIT = rate_limit(
    PREFERENCES_WRITE.scope,
    PREFERENCES_WRITE.limit,
    PREFERENCES_WRITE.window_seconds,
    key="user",
)

router = APIRouter(prefix="/me", tags=["me"])


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
