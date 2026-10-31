"""Request id and access log (pure ASGI, outermost middleware).

The id comes from ``X-Request-ID`` when the caller (the Cloudflare gateway Worker, which sets
one on every request) sends a well-formed value, otherwise a fresh one is generated. It is bound
to the logging context for the whole request, echoed in the ``X-Request-ID`` response header so
a customer-visible error can be matched to its log lines, and written on one access-log line.

The access log records method, the matched route *template* (``/api/v1/orders/{order_id}``, so
ids do not multiply the cardinality), status and duration. Never the client IP, query string,
headers, cookies or body.
"""

import logging
import time
import uuid
from typing import Final

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import REQUEST_ID_PATTERN, reset_request_id, set_request_id

REQUEST_ID_HEADER: Final = "x-request-id"
_access_logger = logging.getLogger("app.access")


def _incoming_request_id(scope: Scope) -> str | None:
    for name, value in scope["headers"]:
        if name == REQUEST_ID_HEADER.encode():
            try:
                text = value.decode("ascii")
            except UnicodeDecodeError:
                return None
            return text if REQUEST_ID_PATTERN.fullmatch(text) else None
    return None


def _route_template(scope: Scope) -> str:
    """The request path with each path-parameter segment replaced by ``{name}``.

    Built from the path and the matched parameters rather than the route object, whose
    ``path`` is relative to the router that included it.
    """
    if scope.get("route") is None:
        return "<unmatched>"
    params: dict[str, object] = scope.get("path_params") or {}
    names = {str(value): name for name, value in params.items()}
    segments = scope["path"].split("/")
    return "/".join(f"{{{names[s]}}}" if s in names else s for s in segments)


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, *, quiet_paths: tuple[str, ...] = ()) -> None:
        self.app = app
        # Liveness probes hit the API every few seconds; they are not worth a log line each.
        self.quiet_paths = frozenset(quiet_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or uuid.uuid4().hex
        token = set_request_id(request_id)
        started = time.perf_counter()
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            if scope["path"] not in self.quiet_paths or status >= 400:
                _access_logger.info(
                    "%s %s %s",
                    scope["method"],
                    _route_template(scope),
                    status,
                    extra={
                        "event": "http_request",
                        "method": scope["method"],
                        "route": _route_template(scope),
                        "status": status,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    },
                )
            reset_request_id(token)
