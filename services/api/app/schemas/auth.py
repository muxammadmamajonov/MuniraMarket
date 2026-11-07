from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.users import UserPublic


class SessionResponse(BaseModel):
    """Returned by every login and by ``GET /auth/session``.

    ``csrf_token`` must be kept in memory by the client and sent as ``X-CSRF-Token`` on every
    state-changing request. The session token itself is only ever in the HTTP-only cookie.
    """

    user: UserPublic
    csrf_token: str


class OidcConfig(BaseModel):
    enabled: bool


class AuthConfigResponse(BaseModel):
    telegram_oidc: OidcConfig


class OidcStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Same-origin path to land on after signing in (e.g. ``/uz/orders``). Anything else is
    # replaced by ``/`` on the server.
    return_to: Annotated[str | None, Field(max_length=512)] = None


class OidcStartResponse(BaseModel):
    # Navigate the browser here (top-level navigation, not a popup or fetch).
    authorization_url: str
