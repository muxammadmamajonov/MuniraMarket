"""Structured logs, redaction, request ids, readiness and the migration-job URL."""

import json
import logging
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from app.api.deps import get_session
from app.core.logging import JsonFormatter, redact, reset_request_id, set_request_id
from app.db.migration_url import migration_database_url
from app.db.session import connect_args
from tests.conftest import make_settings

# --- redaction ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("connect to postgresql+asyncpg://app:hunter2@ep-x.neon.tech/db failed", "hunter2"),
        ("redis error rediss://default:s3cr3t-pass@cache.example:6380/0", "s3cr3t-pass"),
        ("bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw rejected", "AAHdqTcvCH1vGWJxfSeofSAs0"),
        ("recipient +998 90 123-45-67 unreachable", "123-45-67"),
        ("recipient 998901234567 unreachable", "901234567"),
        ("cookie=__Host-mm_session=abcdefghijklmnop", "abcdefghijklmnop"),
        ('payload {"hash": "0123abcd"}', "0123abcd"),
        ("init_data=query_id%3DAAE...&hash=ffee", "query_id"),
        ("Authorization: Bearer-tokenvalue123", "tokenvalue123"),
        ("upstream said Authorization: Bearer abc123def456", "abc123def456"),
        ("refresh failed access_token=eyJhbGciOi.payload.sig", "eyJhbGciOi"),
        ("bot-token: 123:abcdefabcdef", "abcdefabcdef"),
        ('{"client_secret": "s3cr3t-value"}', "s3cr3t-value"),
        ("recipient 90 123 45 67 unreachable", "123 45 67"),
        ("recipient 901234567 unreachable", "901234567"),
        ("recipient (90) 123-45-67 unreachable", "123-45-67"),
    ],
)
def test_redact_masks_secrets_and_phone_numbers(text: str, secret: str) -> None:
    masked = redact(text)
    assert secret not in masked
    assert "[redacted]" in masked


@pytest.mark.parametrize(
    "text",
    [
        "Order created: 0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10 (status=NEW, 3 items)",
        "GET /api/v1/orders/{order_id} 200",
        "Rejected Telegram init data: hash mismatch",
        "Order 1042 total 125000 UZS, 12 lines",
        "core-api starting",
    ],
)
def test_redact_keeps_ordinary_messages(text: str) -> None:
    assert redact(text) == text


def _record(msg: str, *args: object, exc: BaseException | None = None) -> logging.LogRecord:
    exc_info = (type(exc), exc, exc.__traceback__) if exc is not None else None
    return logging.LogRecord("app.test", logging.ERROR, __file__, 1, msg, args, exc_info)


def test_json_formatter_shape_and_request_id() -> None:
    token = set_request_id("req-12345678")
    try:
        record = _record("Order %s refused", "abc")
        record.event = "order"
        record.phone = "+998901234567"  # not allow-listed: never emitted
        line = json.loads(JsonFormatter(env="production", release="sha-1").format(record))
    finally:
        reset_request_id(token)
    assert line["msg"] == "Order abc refused"
    assert line["level"] == "error"
    assert line["request_id"] == "req-12345678"
    assert line["env"] == "production"
    assert line["release"] == "sha-1"
    assert line["event"] == "order"
    assert "phone" not in line
    assert "998901234567" not in json.dumps(line)


def _fail() -> None:
    raise ConnectionError("postgresql+asyncpg://app:hunter2@db.internal/prod is down")


def test_json_formatter_redacts_exception_text() -> None:
    try:
        _fail()
    except ConnectionError as exc:
        record = _record("Unhandled", exc=exc)
    line = JsonFormatter(env="test", release=None).format(record)
    assert "hunter2" not in line
    parsed = json.loads(line)
    assert parsed["exc_type"] == "ConnectionError"
    assert "traceback" in parsed


# --- request id and access log ------------------------------------------------------------


async def test_response_carries_a_generated_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/nope")
    request_id = response.headers["x-request-id"]
    assert len(request_id) == 32
    assert request_id.isalnum()


async def test_well_formed_incoming_request_id_is_kept(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/health", headers={"X-Request-ID": "cf-ray-8d2f1b7a10-AMS"})
    assert response.headers["x-request-id"] == "cf-ray-8d2f1b7a10-AMS"


@pytest.mark.parametrize("bad", ["short", "has space in it", "x" * 129, "semi;colon-12345"])
async def test_malformed_incoming_request_id_is_replaced(
    client: httpx.AsyncClient, bad: str
) -> None:
    response = await client.get("/api/v1/health", headers={"X-Request-ID": bad})
    assert response.headers["x-request-id"] != bad


async def test_access_log_uses_route_template_without_query_or_ip(
    app: FastAPI, client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    @app.get("/api/v1/test/items/{item_id}")
    async def item(item_id: str) -> dict[str, str]:
        return {"id": item_id}

    with caplog.at_level(logging.INFO, logger="app.access"):
        response = await client.get(
            "/api/v1/test/items/item-42?q=secret-search",
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    assert response.status_code == 200
    records: list[Any] = [r for r in caplog.records if r.name == "app.access"]
    assert len(records) == 1
    record = records[0]
    assert record.route == "/api/v1/test/items/{item_id}"
    assert (record.method, record.status) == ("GET", 200)
    assert isinstance(record.duration_ms, float)
    app_text = " ".join(
        f"{r.getMessage()} {vars(r)}" for r in caplog.records if r.name.startswith("app.")
    )
    assert "secret-search" not in app_text
    assert "203.0.113.9" not in app_text
    assert "item-42" not in app_text


async def test_liveness_probe_is_not_access_logged(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app.access"):
        await client.get("/api/v1/health")
    assert not [r for r in caplog.records if r.name == "app.access"]


# --- readiness -----------------------------------------------------------------------------


class _OkSession:
    async def execute(self, statement: object) -> None:
        return None


async def test_ready_checks_redis_when_configured(app: FastAPI, client: httpx.AsyncClient) -> None:
    async def session() -> _OkSession:
        return _OkSession()

    async def broken_ping() -> bool:
        raise ConnectionError("rediss://default:s3cr3t@cache:6380 refused")

    app.dependency_overrides[get_session] = session
    app.state.redis_ping = broken_ping
    response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert response.headers["cache-control"] == "no-store"
    assert "s3cr3t" not in response.text

    async def ok_ping() -> bool:
        return True

    app.state.redis_ping = ok_ping
    assert (await client.get("/api/v1/health/ready")).status_code == 200


# --- database connection settings ---------------------------------------------------------


def test_connect_args_set_application_name_and_timeouts() -> None:
    args = connect_args(make_settings(db_statement_timeout_ms=5000, db_connect_timeout_seconds=7))
    assert args["timeout"] == 7
    assert args["server_settings"]["application_name"] == "muniramarket-core-api"
    assert args["server_settings"]["statement_timeout"] == "5000"
    assert args["server_settings"]["idle_in_transaction_session_timeout"] == "30000"


def test_zero_disables_server_timeouts() -> None:
    args = connect_args(
        make_settings(db_statement_timeout_ms=0, db_idle_in_transaction_timeout_ms=0)
    )
    assert set(args["server_settings"]) == {"application_name"}


# --- migration job URL --------------------------------------------------------------------

_MIGRATION_URL = "postgresql+asyncpg://migrator:pw@ep-x.example.test/app?ssl=verify-full"


def test_migration_url_is_used_when_set() -> None:
    env = {"APP_ENV": "production", "MIGRATION_DATABASE_URL": _MIGRATION_URL}
    assert migration_database_url(env) == _MIGRATION_URL


@pytest.mark.parametrize(
    ("env", "message"),
    [
        (
            {"APP_ENV": "production", "MIGRATION_DATABASE_URL": "postgresql://m:pw@h/app"},
            "asyncpg:// scheme",
        ),
        (
            {
                "APP_ENV": "staging",
                "MIGRATION_DATABASE_URL": "postgresql+asyncpg://m:pw@h/app",
            },
            "ssl=verify-full",
        ),
        (
            {
                "APP_ENV": "development",
                "MIGRATION_DATABASE_URL": "postgresql+asyncpg://m:pw@h/app?sslmode=require",
            },
            "sslmode",
        ),
        ({"MIGRATION_DATABASE_URL": _MIGRATION_URL}, "APP_ENV"),
    ],
)
def test_migration_url_is_validated(env: dict[str, str], message: str) -> None:
    with pytest.raises(ValueError, match=message) as excinfo:
        migration_database_url(env)
    assert "pw@" not in str(excinfo.value)


def test_settings_errors_do_not_echo_database_url() -> None:
    with pytest.raises(ValidationError) as excinfo:
        make_settings(
            app_env="production",
            database_url="postgresql+asyncpg://app:hunter2@db.example.test/app",
        )
    assert "hunter2" not in str(excinfo.value)
