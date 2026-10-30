import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import __version__
from app.api.deps import SessionDep
from app.schemas.health import HealthResponse, ReadinessResponse

logger = logging.getLogger("app.health")
router = APIRouter(prefix="/health", tags=["health"])


@router.get("", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness: the process is up. Touches no dependency."""
    return HealthResponse(status="ok", service="core-api", version=__version__)


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse, "description": "Database unavailable"}},
)
async def ready(session: SessionDep) -> ReadinessResponse | JSONResponse:
    """Readiness: the database answers ``SELECT 1``. Failures are logged, never returned."""
    try:
        await session.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(
            status_code=503, content=ReadinessResponse(status="unavailable").model_dump()
        )
    return ReadinessResponse(status="ok")
