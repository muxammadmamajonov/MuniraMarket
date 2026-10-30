"""Pure-ASGI request body size limit.

Rejects oversized requests early (declared ``Content-Length``) and also while streaming, so a
client cannot bypass the cap with chunked transfer encoding or a lying header.
"""

from collections.abc import Mapping

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import error_body

DEFAULT_MAX_BODY_BYTES = 64 * 1024
_TOO_LARGE_MESSAGE = "Request body too large"


class BodySizeLimitMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        max_bytes: int = DEFAULT_MAX_BODY_BYTES,
        path_limits: Mapping[str, int] | None = None,
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.path_limits = dict(path_limits or {})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.path_limits.get(scope["path"], self.max_bytes)
        for name, value in scope["headers"]:
            if name == b"content-length":
                if value.isascii() and value.isdigit() and int(value) > limit:
                    response = JSONResponse(
                        error_body("payload_too_large", _TOO_LARGE_MESSAGE), status_code=413
                    )
                    await response(scope, receive, send)
                    return
                break

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # An HTTPException (not a bare error) so FastAPI's body parsing re-raises it
                    # and the uniform error handler renders a 413 envelope.
                    raise HTTPException(status_code=413, detail=_TOO_LARGE_MESSAGE)
            return message

        await self.app(scope, limited_receive, send)
