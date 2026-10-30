"""Notification outbox for the Telegram Serverless transport (ADR 0008). Signed requests only
(ADR 0003), with an empty actor: draining acts for the service, never for a Telegram user.

``POST /claim`` leases due messages; ``POST /{id}/result`` reports what happened to one. Bodies are
validated only after the signature check, so unauthenticated callers learn nothing.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.deps import SessionDep
from app.api.routes.orders import NowDep
from app.repositories.outbox import (
    LEASE,
    OutboxRepository,
    ReportedOutcome,
    SqlAlchemyOutboxRepository,
)
from app.security.service_auth import ServiceContext, require_service_request

router = APIRouter(prefix="/internal/telegram/notifications", tags=["internal"])


async def require_service_without_actor(
    context: Annotated[ServiceContext, Depends(require_service_request)],
) -> ServiceContext:
    if context.actor_telegram_user_id is not None:
        raise HTTPException(status_code=403, detail="Service requests only")
    return context


def get_outbox_repository(session: SessionDep) -> OutboxRepository:
    return SqlAlchemyOutboxRepository(session)


ServiceDep = Annotated[ServiceContext, Depends(require_service_without_actor)]
OutboxRepositoryDep = Annotated[OutboxRepository, Depends(get_outbox_repository)]


class ClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=20, ge=1, le=50)


class OutboxMessagePublic(BaseModel):
    id: uuid.UUID
    # Currently always ``order.status_changed``; ignore types you do not know (report ``failed``).
    event_type: str
    # ``order.status_changed``: order_id, order_number, status, locale, total_uzs, chat_id and,
    # when cancelled with a reason, cancel_reason.
    payload: dict[str, Any]
    attempts: int


class ClaimResponse(BaseModel):
    items: list[OutboxMessagePublic]
    # Report every message before this instant, or it becomes claimable again.
    lease_expires_at: datetime


class ResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: ReportedOutcome
    # Short machine code from the transport (e.g. ``bot_api_429``); never message text.
    error_code: str | None = Field(default=None, pattern=r"^[a-z0-9_.-]{1,64}$")


async def _parse[M: BaseModel](request: Request, model: type[M]) -> M:
    body = await request.body()
    try:
        return model.model_validate_json(body or b"{}")
    except ValidationError as exc:
        raise RequestValidationError(
            exc.errors(include_url=False, include_input=False, include_context=False)
        ) from None


def _schema(model: type[BaseModel]) -> dict[str, Any]:
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


@router.post("/claim", response_model=ClaimResponse, openapi_extra=_schema(ClaimRequest))
async def claim(
    request: Request, _: ServiceDep, outbox: OutboxRepositoryDep, now: NowDep
) -> ClaimResponse:
    payload = await _parse(request, ClaimRequest)
    messages = await outbox.claim(limit=payload.limit, now=now)
    return ClaimResponse(
        items=[
            OutboxMessagePublic(
                id=m.id, event_type=m.event_type, payload=m.payload, attempts=m.attempts
            )
            for m in messages
        ],
        lease_expires_at=now + LEASE,
    )


@router.post("/{message_id}/result", status_code=204, openapi_extra=_schema(ResultRequest))
async def report_result(
    message_id: uuid.UUID,
    request: Request,
    _: ServiceDep,
    outbox: OutboxRepositoryDep,
    now: NowDep,
) -> None:
    """``retry`` backs off exponentially and gives up (``failed``) after 8 attempts.

    404 when the message is unknown, already finished, or was never claimed.
    """
    payload = await _parse(request, ResultRequest)
    found = await outbox.report(message_id, payload.outcome, error_code=payload.error_code, now=now)
    if not found:
        raise HTTPException(status_code=404, detail="Message not found")
