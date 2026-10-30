import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import __version__
from app.api.deps import SessionDep

logger = logging.getLogger("app.health")
router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
async def health() -> dict[str, str]:
    """Liveness: the process is up. Touches no dependency."""
    return {"status": "ok", "service": "core-api", "version": __version__}


@router.get("/ready", response_model=None)
async def ready(session: SessionDep) -> Any:
    """Readiness: the database answers ``SELECT 1``. Failures are logged, never returned."""
    try:
        await session.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ok"}
