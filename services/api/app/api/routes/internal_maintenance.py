"""Housekeeping for the scheduler Worker (ADR 0013, ADR 0015). Signed, empty actor only."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import SessionDep
from app.api.routes.internal_notifications import require_service_without_actor
from app.api.routes.orders import NowDep
from app.repositories.security_state import delete_expired
from app.security.service_auth import ServiceContext

logger = logging.getLogger("app.internal.maintenance")
router = APIRouter(prefix="/internal/maintenance", tags=["internal"])

ServiceDep = Annotated[ServiceContext, Depends(require_service_without_actor)]


@router.post("/cleanup", status_code=204)
async def cleanup(_: ServiceDep, session: SessionDep, now: NowDep) -> None:
    """Delete expired sessions, rate-limit windows, replay nonces and OIDC login states.

    Correctness never depends on this (readers filter on ``expires_at``); it only bounds table
    size. Safe to call concurrently and repeatedly.
    """
    removed = await delete_expired(session, now=now)
    logger.info("Expired security state removed", extra={"event": "cleanup", **removed})
