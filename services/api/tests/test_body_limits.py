"""Body-size caps and ordering of the service-auth checks relative to reading the body."""

import json
from collections.abc import AsyncIterator
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Request
from pydantic import SecretStr
from starlette.types import ASGIApp, Message

from app.core.errors import register_exception_handlers
from app.security.service_auth import (
    MAX_BODY_BYTES,
    InMemoryNonceStore,
    ServiceAuthenticator,
    ServiceContext,
    require_service_request,
)
from tests.conftest import NOW, TEST_KEY_ID, TEST_SECRET, FakeClock
from tests.test_service_auth import SESSION_PATH, signed_headers

INIT_DATA_PATH = "/api/v1/auth/telegram/init-data"
OVERSIZE = MAX_BODY_BYTES + 1


class BodyWasReadError(AssertionError):
    pass


async def _forbidden_receive() -> Message:
    raise BodyWasReadError("the request body must not be read")


async def _call_asgi(
    app: ASGIApp, *, method: str, path: str, headers: dict[str, str], receive: Any
) -> tuple[int, bytes]:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
    }
    status = 0
    chunks: list[bytes] = []

    async def send(message: Message) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await app(scope, receive, send)
    return status, b"".join(chunks)


def _auth_only_app(clock: FakeClock) -> FastAPI:
    """App with only the auth dependency: no body-limit middleware to lean on."""
    app = FastAPI()
    app.state.service_authenticator = ServiceAuthenticator(
        keys={TEST_KEY_ID: SecretStr(TEST_SECRET)},
        nonce_store=InMemoryNonceStore(clock),
        clock=clock,
    )
    register_exception_handlers(app)

    @app.post("/echo")
    async def echo(
        ctx: Annotated[ServiceContext, Depends(require_service_request)],
    ) -> dict[str, str]:
        return {"key_id": ctx.key_id}

    return app


async def _chunks(total: int, size: int = 8192) -> AsyncIterator[bytes]:
    sent = 0
    while sent < total:
        piece = min(size, total - sent)
        yield b"x" * piece
        sent += piece


# --- app-wide middleware ----------------------------------------------------------------------


async def test_oversized_content_length_rejected_before_reading_body(app: FastAPI) -> None:
    status, body = await _call_asgi(
        app,
        method="POST",
        path=SESSION_PATH,
        headers={"content-length": str(OVERSIZE), "content-type": "application/json"},
        receive=_forbidden_receive,
    )
    assert status == 413
    assert json.loads(body)["error"]["code"] == "payload_too_large"


async def test_oversized_chunked_body_is_413(client: httpx.AsyncClient) -> None:
    headers = signed_headers(method="POST", path=SESSION_PATH)
    headers["Content-Type"] = "application/json"
    response = await client.post(SESSION_PATH, content=_chunks(OVERSIZE), headers=headers)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


async def test_body_at_the_limit_is_still_processed(client: httpx.AsyncClient) -> None:
    body = b"x" * MAX_BODY_BYTES
    response = await client.post(
        SESSION_PATH, content=body, headers=signed_headers(method="POST", path=SESSION_PATH)
    )
    assert response.status_code == 401  # passes the size gate, fails the signature (body differs)


async def test_init_data_route_has_a_stricter_cap(client: httpx.AsyncClient) -> None:
    too_big = b'{"init_data":"' + b"a" * (8 * 1024) + b'"}'
    response = await client.post(
        INIT_DATA_PATH, content=too_big, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413

    chunked = await client.post(
        INIT_DATA_PATH,
        content=_chunks(9 * 1024),
        headers={"Content-Type": "application/json"},
    )
    assert chunked.status_code == 413

    # Within the byte cap but over the field limit: ordinary validation error.
    response = await client.post(INIT_DATA_PATH, json={"init_data": "x" * 4097})
    assert response.status_code == 422


async def test_non_http_scopes_pass_through(app: FastAPI) -> None:
    # Lifespan must still work with the middleware installed.
    async with app.router.lifespan_context(app):
        pass


# --- defence in depth inside the auth dependency ------------------------------------------------


async def test_dependency_rejects_oversized_content_length_without_reading(
    clock: FakeClock,
) -> None:
    app = _auth_only_app(clock)
    headers = signed_headers(method="POST", path="/echo")
    headers["content-length"] = str(OVERSIZE)
    status, _ = await _call_asgi(
        app, method="POST", path="/echo", headers=headers, receive=_forbidden_receive
    )
    assert status == 413


async def test_dependency_rejects_oversized_chunked_body(clock: FakeClock) -> None:
    app = _auth_only_app(clock)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        response = await http_client.post(
            "/echo",
            content=_chunks(OVERSIZE),
            headers=signed_headers(method="POST", path="/echo"),
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


async def test_unknown_key_rejected_without_reading_body(clock: FakeClock) -> None:
    app = _auth_only_app(clock)
    headers = signed_headers(method="POST", path="/echo", key_id="nope")
    status, body = await _call_asgi(
        app, method="POST", path="/echo", headers=headers, receive=_forbidden_receive
    )
    assert status == 401
    assert json.loads(body)["error"]["code"] == "unauthorized"


async def test_stale_and_future_timestamps_rejected_without_reading_body(
    clock: FakeClock,
) -> None:
    app = _auth_only_app(clock)
    for timestamp in (int(NOW) - 301, int(NOW) + 301):
        headers = signed_headers(method="POST", path="/echo", timestamp=timestamp)
        status, _ = await _call_asgi(
            app, method="POST", path="/echo", headers=headers, receive=_forbidden_receive
        )
        assert status == 401


async def test_malformed_headers_rejected_without_reading_body(clock: FakeClock) -> None:
    app = _auth_only_app(clock)
    headers = signed_headers(method="POST", path="/echo")
    headers["X-MM-Nonce"] = "short"
    status, _ = await _call_asgi(
        app, method="POST", path="/echo", headers=headers, receive=_forbidden_receive
    )
    assert status == 401


async def test_valid_request_still_works_and_body_is_cached(clock: FakeClock) -> None:
    app = _auth_only_app(clock)
    body_seen: list[bytes] = []

    @app.post("/cached")
    async def cached(
        request: Request, _: Annotated[ServiceContext, Depends(require_service_request)]
    ) -> dict[str, int]:
        body_seen.append(await request.body())
        return {"len": len(body_seen[-1])}

    payload = b'{"hello":"world"}'
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        response = await http_client.post(
            "/cached",
            content=payload,
            headers=signed_headers(method="POST", path="/cached", body=payload),
        )
    assert response.status_code == 200
    assert body_seen == [payload]
