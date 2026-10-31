import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Request
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


def _unavailable() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content=ReadinessResponse(status="unavailable").model_dump(),
        headers={"cache-control": "no-store"},
    )


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse, "description": "Database or Redis unavailable"}},
)
async def ready(request: Request, session: SessionDep) -> ReadinessResponse | JSONResponse:
    """Readiness: the database answers ``SELECT 1`` and, when sessions and rate limits use
    Redis, Redis answers ``PING``. Failures are logged by class only, never returned."""
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.error("Readiness check failed: database (%s)", type(exc).__name__)  # noqa: TRY400
        return _unavailable()
    ping: Callable[[], Awaitable[object]] | None = getattr(request.app.state, "redis_ping", None)
    if ping is not None:
        try:
            await ping()
        except Exception as exc:
            logger.error("Readiness check failed: redis (%s)", type(exc).__name__)  # noqa: TRY400
            return _unavailable()
    return ReadinessResponse(status="ok")
