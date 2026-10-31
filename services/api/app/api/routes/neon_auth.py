"""Neon Auth (Managed Better Auth) identity check.

``GET /api/v1/auth/neon/me`` with ``Authorization: Bearer <Neon Auth JWT>`` returns who the token
belongs to. It is an identity probe only: it creates no session and grants no role; the
storefront and admin keep their Telegram-based sessions (ADR 0004, ADR 0007).
"""

from fastapi import APIRouter, Request

from app.core.errors import ApiError, error_responses
from app.schemas.auth import NeonIdentityResponse
from app.security.neon_auth import NeonAuthError, NeonAuthVerifier

router = APIRouter(prefix="/auth/neon", tags=["auth"])

_BEARER = "bearer "


@router.get(
    "/me",
    response_model=NeonIdentityResponse,
    responses=error_responses(401, 503),
)
async def neon_me(request: Request) -> NeonIdentityResponse:
    verifier: NeonAuthVerifier | None = request.app.state.neon_auth_verifier
    if verifier is None:
        raise ApiError(503, "feature_disabled", "Neon Auth is not configured")
    header = request.headers.get("authorization", "")
    if not header.lower().startswith(_BEARER):
        raise ApiError(401, "unauthorized", "A Neon Auth bearer token is required")
    try:
        identity = await verifier.verify(header[len(_BEARER) :].strip())
    except NeonAuthError:
        raise ApiError(401, "unauthorized", "Invalid Neon Auth token") from None
    return NeonIdentityResponse(user_id=identity.user_id, email=identity.email, name=identity.name)
