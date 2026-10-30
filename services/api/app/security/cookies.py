"""Session cookie formatting and delivery (ADR 0007).

Dependencies never write ``Set-Cookie`` on the response object directly. They queue the header
on the request (:func:`queue_session_cookie`) and :class:`SessionCookieMiddleware` adds it to
whatever response leaves the app, including error envelopes. Otherwise a token rotated by the
session dependency would be lost (and the user signed out) whenever the route then failed, for
example with ``409 insufficient_stock`` or ``403 csrf_failed``.

The middleware also marks auth responses and every response that carries a session cookie
``Cache-Control: no-store``.
"""

from typing import Any, Final

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

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


class SessionCookieMiddleware:
    def __init__(self, app: ASGIApp, *, no_store_prefixes: tuple[str, ...] = ()) -> None:
        self.app = app
        self.no_store_prefixes = no_store_prefixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        no_store_path = path.startswith(self.no_store_prefixes) if self.no_store_prefixes else False

        async def send_with_cookie(message: Message) -> None:
            if message["type"] == "http.response.start":
                state: dict[str, Any] = scope.get("state") or {}
                cookie = state.get(_STATE_KEY)
                if cookie is not None or no_store_path:
                    headers = MutableHeaders(scope=message)
                    if cookie is not None:
                        headers.append("set-cookie", cookie)
                    headers["cache-control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_with_cookie)
