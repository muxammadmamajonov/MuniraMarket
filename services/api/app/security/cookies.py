"""Session cookie formatting and delivery (ADR 0007).

Dependencies never write ``Set-Cookie`` on the response object directly. They queue the header
on the request (:func:`queue_session_cookie`) and :class:`SessionCookieMiddleware` adds it to
whatever response leaves the app, including error envelopes. Otherwise a token rotated by the
session dependency would be lost (and the user signed out) whenever the route then failed, for
example with ``409 insufficient_stock`` or ``403 csrf_failed``.

That includes unhandled exceptions: Starlette's catch-all handler runs outside every user
middleware, so the middleware turns them into the generic ``500 internal_error`` envelope itself,
cookie included.

The middleware also marks every response under the configured no-store paths (auth, cart) and
every response that carries a session cookie ``Cache-Control: no-store``.
"""

from typing import Any, Final

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import internal_error_response, log_unhandled_exception

_STATE_KEY: Final = "mm_session_cookie"
_EXPIRED: Final = "Thu, 01 Jan 1970 00:00:00 GMT"


def session_cookie_header(*, name: str, token: str, max_age: int, secure: bool) -> str:
    """``HttpOnly; SameSite=Lax; Path=/``, never ``Domain`` (host-only cookie)."""
    parts = [f"{name}={token}", f"Max-Age={max_age}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def expired_cookie_header(*, name: str, secure: bool) -> str:
    parts = [f'{name}=""', f"expires={_EXPIRED}", "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def queue_session_cookie(request: Request, header_value: str) -> None:
    """Send ``Set-Cookie: header_value`` with the response, whatever its status.

    A later call replaces an earlier one: only the final session state reaches the browser.
    """
    request.state.mm_session_cookie = header_value  # read back via scope["state"][_STATE_KEY]


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    """``path`` is one of ``prefixes`` or below it (``/cart`` covers ``/cart/items``, not
    ``/carts``)."""
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in prefixes)


class SessionCookieMiddleware:
    def __init__(self, app: ASGIApp, *, no_store_paths: tuple[str, ...] = ()) -> None:
        self.app = app
        self.no_store_paths = tuple(path.rstrip("/") for path in no_store_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        no_store_path = _under(scope["path"], self.no_store_paths)
        response_started = False

        async def send_with_cookie(message: Message, *, force_no_store: bool = False) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                state: dict[str, Any] = scope.get("state") or {}
                cookie = state.get(_STATE_KEY)
                if cookie is not None or no_store_path or force_no_store:
                    headers = MutableHeaders(scope=message)
                    if cookie is not None:
                        headers.append("set-cookie", cookie)
                    headers["cache-control"] = "no-store"
            await send(message)

        try:
            await self.app(scope, receive, send_with_cookie)
        except Exception as exc:
            if response_started:
                raise  # too late for an envelope; the server closes the connection
            log_unhandled_exception(scope.get("method", ""), scope["path"], exc)

            async def send_error(message: Message) -> None:
                await send_with_cookie(message, force_no_store=True)

            await internal_error_response()(scope, receive, send_error)
