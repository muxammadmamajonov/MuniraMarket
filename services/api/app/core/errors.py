"""Uniform error envelope: ``{"error": {"code": ..., "message": ...}}``."""

import logging
from http import HTTPStatus
from typing import Any, Literal, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")

_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
    503: "service_unavailable",
}


# Every machine-readable error code the public API can return. Clients switch on these; the
# message is for humans and may change. Keep in sync with the generated TypeScript contract.
ErrorCode = Literal[
    # generic (derived from the HTTP status)
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "method_not_allowed",
    "conflict",
    "payload_too_large",
    "unsupported_media_type",
    "validation_error",
    "rate_limited",
    "internal_error",
    "service_unavailable",
    # auth / session
    "invalid_telegram_auth",
    "session_required",
    "csrf_failed",
    "account_blocked",
    "feature_disabled",
    # catalog / cart
    "category_not_found",
    "product_not_found",
    "product_inactive",
    "insufficient_stock",
    "cart_limit_reached",
    "cart_item_not_found",
]


class ErrorDetail(BaseModel):
    loc: list[str]
    msg: str


class ApiErrorBody(BaseModel):
    code: ErrorCode
    message: str
    details: list[ErrorDetail] | None = None
    # Only set for ``insufficient_stock``: how many units can currently be ordered.
    available_quantity: int | None = None


class ErrorEnvelope(BaseModel):
    """Shape of every non-2xx JSON response."""

    error: ApiErrorBody


class ApiError(Exception):
    """Raise from routes/services to return a typed error envelope."""

    def __init__(
        self,
        status_code: int,
        code: ErrorCode,
        message: str,
        *,
        headers: dict[str, str] | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers
        self.extra = extra


def error_responses(*status_codes: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI ``responses=`` entries so error shapes appear in the generated contract."""
    return {status: {"model": ErrorEnvelope} for status in status_codes}


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, **extra}}


def _code_for(status_code: int) -> str:
    return _CODES.get(status_code, f"http_{status_code}")


async def _http_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    exc = cast("StarletteHTTPException", exc)
    message = exc.detail if isinstance(exc.detail, str) else HTTPStatus(exc.status_code).phrase
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(_code_for(exc.status_code), message),
        headers=exc.headers,
    )


async def _api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    exc = cast("ApiError", exc)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, **exc.extra),
        headers=exc.headers,
    )


async def _validation_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    exc = cast("RequestValidationError", exc)
    # Only location and message are exposed; submitted values are never echoed back.
    details = [
        {
            "loc": [str(part) for part in err.get("loc", ())],
            "msg": str(err.get("msg", "")),
        }
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content=error_body("validation_error", "Request validation failed", details=details),
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error(
        "Unhandled exception on %s %s",
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(
        status_code=500,
        content=error_body("internal_error", "Internal server error"),
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
