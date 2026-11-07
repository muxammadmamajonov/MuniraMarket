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


def _unavailable() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content=ReadinessResponse(status="unavailable").model_dump(),
        headers={"cache-control": "no-store"},
    )


# One probe per security-state table (ADR 0013): a missing migration or grant makes the
# instance unready instead of failing every signed-in request. ``LIMIT 0`` reads no rows.
_READINESS_PROBES = (
    "SELECT 1",
    "SELECT 1 FROM auth_sessions LIMIT 0",
    "SELECT 1 FROM rate_limit_counters LIMIT 0",
    "SELECT 1 FROM service_request_nonces LIMIT 0",
    "SELECT 1 FROM oidc_login_states LIMIT 0",
)


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    responses={503: {"model": ReadinessResponse, "description": "Database unavailable"}},
)
async def ready(session: SessionDep) -> ReadinessResponse | JSONResponse:
    """Readiness: the database answers and the security-state tables (sessions, rate limits,
    replay nonces, OIDC states) are reachable. Failures are logged by class only."""
    try:
        for probe in _READINESS_PROBES:
            await session.execute(text(probe))
    except Exception as exc:
        logger.error("Readiness check failed: database (%s)", type(exc).__name__)  # noqa: TRY400
        return _unavailable()
    return ReadinessResponse(status="ok")
