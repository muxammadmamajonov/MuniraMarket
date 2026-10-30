from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Liveness probe body."""

    status: Literal["ok"]
    service: Literal["core-api"]
    version: str


class ReadinessResponse(BaseModel):
    """Readiness probe body. Status "unavailable" is returned with HTTP 503."""

    status: Literal["ok", "unavailable"]
