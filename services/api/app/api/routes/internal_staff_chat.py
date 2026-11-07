"""``/connect_orders`` backend for the Telegram Serverless bot (ADR 0015). Signed requests only.

The bot sends the group's chat id with the sender as the signed actor; this route decides. Only an
``admin`` in the Core API may connect a group; the answer says nothing about who else is admin.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.deps import SessionDep, require_actor
from app.repositories.staff_chat import SqlAlchemyStaffChatRepository, StaffChatRepository

router = APIRouter(prefix="/internal/telegram/staff-chat", tags=["internal"])

ActorDep = Annotated[int, Depends(require_actor)]


def get_staff_chat_repository(session: SessionDep) -> StaffChatRepository:
    return SqlAlchemyStaffChatRepository(session)


StaffChatRepositoryDep = Annotated[StaffChatRepository, Depends(get_staff_chat_repository)]


class ConnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Telegram group and supergroup ids are negative; private chats (positive) are refused.
    chat_id: int = Field(lt=0, ge=-(10**15))
    chat_type: Literal["group", "supergroup"]


class ConnectResponse(BaseModel):
    connected: bool


@router.post(
    "/connect",
    response_model=ConnectResponse,
    responses={403: {"description": "The actor is not an admin"}},
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": ConnectRequest.model_json_schema()}},
        }
    },
)
async def connect(
    request: Request, actor_telegram_user_id: ActorDep, repository: StaffChatRepositoryDep
) -> ConnectResponse:
    """Make the given group the staff order-alert chat. ``403`` unless the actor is an admin."""
    try:
        payload = ConnectRequest.model_validate_json(await request.body())
    except ValidationError as exc:
        raise RequestValidationError(
            exc.errors(include_url=False, include_input=False, include_context=False)
        ) from None
    result = await repository.connect(
        telegram_user_id=actor_telegram_user_id, chat_id=payload.chat_id
    )
    if result.outcome != "connected":
        raise HTTPException(status_code=403, detail="Admin role required")
    return ConnectResponse(connected=True)
