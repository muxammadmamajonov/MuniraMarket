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


class LoginWidgetConfig(BaseModel):
    enabled: bool
    bot_username: str | None


class AuthConfigResponse(BaseModel):
    telegram_login_widget: LoginWidgetConfig


class LoginWidgetRequest(BaseModel):
    """Fields of the Telegram Login Widget callback, passed through unchanged.

    Unknown fields are rejected: they would otherwise be silently included in (or excluded from)
    the signed data-check-string.
    """

    model_config = ConfigDict(extra="forbid")

    id: Annotated[int, Field(gt=0)]
    first_name: Annotated[str, Field(min_length=1, max_length=255)]
    last_name: Annotated[str | None, Field(max_length=255)] = None
    username: Annotated[str | None, Field(max_length=64)] = None
    photo_url: Annotated[str | None, Field(max_length=2048)] = None
    auth_date: Annotated[int, Field(gt=0)]
    hash: Annotated[str, Field(min_length=64, max_length=64)]

    def signed_fields(self) -> dict[str, str]:
        """The fields as Telegram signed them (absent optional fields are omitted)."""
        return {key: str(value) for key, value in self.model_dump().items() if value is not None}


class NeonIdentityResponse(BaseModel):
    """Who a verified Neon Auth JWT belongs to (``GET /auth/neon/me``)."""

    user_id: str
    email: str | None
    name: str | None
