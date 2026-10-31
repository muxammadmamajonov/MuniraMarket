"""Structured JSON logging with a per-request id and a last-line-of-defence redactor.

Every log line is one JSON object (``ts``, ``level``, ``logger``, ``msg``, ``request_id``,
``env``, ``release`` and, for errors, ``exc_type`` / ``traceback``). The platform (Cloudflare
Containers / Workers Logs) indexes these fields.

Call sites already avoid personal data: they log ids, codes and classes, never bodies, headers,
cookies, query strings, addresses, phone numbers or ``initData``. :func:`redact` is a backstop on
the *formatted* message and traceback so a future mistake (an exception whose text embeds a
connection URL, a phone number or a token) is masked before it leaves the process.
"""

import json
import logging
import re
import sys
import traceback
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Final, Literal

LogFormat = Literal["json", "text"]

_request_id: ContextVar[str | None] = ContextVar("mm_request_id", default=None)

# Bounded and plain so a request id can be echoed in a header and logged without escaping.
REQUEST_ID_PATTERN: Final = re.compile(r"^[A-Za-z0-9._-]{8,128}$")

_REDACTED: Final = "[redacted]"
_REDACTIONS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    # Credentials inside URLs: postgresql+asyncpg://user:password@host, rediss://:password@host.
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]*@"), r"\1" + _REDACTED + "@"),
    # Telegram bot tokens: <bot id>:<35+ url-safe characters>.
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"), _REDACTED),
    # Authorization values with their scheme: "Bearer abc", "Basic abc".
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"), r"\1 " + _REDACTED),
    # Secret-looking assignments, also inside longer snake/kebab keys (access_token=, bot-token:,
    # client_secret=, "hash": "..."): the key is kept, the value masked.
    (
        re.compile(
            r"(?i)([A-Za-z0-9_-]*(?:authorization|cookie|token|csrf|hash|signature|init_?data|"
            r"password|passwd|secret|api_?key|mm_session)[A-Za-z0-9_-]*)"
            r"(\"?\s*[:=]\s*\"?)(?!\[redacted\])[^\s\"',;&]+"
        ),
        r"\1\2" + _REDACTED,
    ),
    # Uzbek phone numbers: +998 / 998 and nine digits, or the nine-digit local form
    # (90 123 45 67, 901234567), with optional separators.
    (re.compile(r"\+?998[\s()-]*\d{2}[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}"), _REDACTED),
    (re.compile(r"(?<![\w-])\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\w-])"), _REDACTED),
    # Any other international number written with a leading +.
    (re.compile(r"(?<![\w-])\+\d[\d\s()-]{7,}\d"), _REDACTED),
)


def redact(text: str) -> str:
    """Mask credentials, tokens and phone numbers in ``text``."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def get_request_id() -> str | None:
    return _request_id.get()


def set_request_id(value: str | None) -> object:
    """Bind ``value`` to the current context; returns a token for :func:`reset_request_id`."""
    return _request_id.set(value)


def reset_request_id(token: object) -> None:
    _request_id.reset(token)  # type: ignore[arg-type]


# Attributes of a LogRecord that are not user-supplied ``extra`` fields.
_RESERVED: Final = frozenset(
    vars(logging.LogRecord("", 0, "", 0, "", None, None)).keys() | {"message", "asctime"}
)
# ``extra=`` keys a call site may attach; anything else is dropped rather than risk logging
# a payload someone passed by accident.
_ALLOWED_EXTRA: Final = frozenset(
    {
        "event",
        "method",
        "route",
        "status",
        "duration_ms",
        "env",
        "release",
        "db_pool_size",
        "db_max_overflow",
        "scope",
    }
)


class JsonFormatter(logging.Formatter):
    def __init__(self, *, env: str, release: str | None) -> None:
        super().__init__()
        self._static = {"env": env, "release": release}

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": redact(record.getMessage()),
            "request_id": get_request_id(),
            **self._static,
        }
        for key, value in vars(record).items():
            if key in _ALLOWED_EXTRA and key not in _RESERVED:
                entry[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            exc_type, exc, tb = record.exc_info
            entry["exc_type"] = exc_type.__name__
            # The exception message can carry data (a URL, a row); keep it, redacted.
            entry["exc_msg"] = redact(str(exc))[:500]
            entry["traceback"] = redact("".join(traceback.format_tb(tb)))
        return json.dumps(entry, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    """Human-readable lines for local development, with the same redaction."""

    def __init__(self) -> None:
        super().__init__("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s")

    def format(self, record: logging.LogRecord) -> str:
        record.request_id = get_request_id() or "-"
        return redact(super().format(record))


# uvicorn installs its own handlers; route them through ours instead. Its access log is
# disabled in the image (it would log client IPs and query strings); ours is below.
_HANDLER_NAME: Final = "muniramarket-json"
_UVICORN_LOGGERS: Final = ("uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi")


def configure_logging(
    *, level: str = "INFO", fmt: LogFormat = "json", env: str, release: str | None
) -> None:
    """Install one stdout handler on the root logger. Safe to call more than once."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter(env=env, release=release) if fmt == "json" else TextFormatter()
    )
    handler.set_name(_HANDLER_NAME)
    root = logging.getLogger()
    # Replace only our own handler (a second create_app in one process); handlers others
    # installed, such as pytest's log capture, stay.
    root.handlers = [h for h in root.handlers if h.get_name() != _HANDLER_NAME]
    root.addHandler(handler)
    root.setLevel(level)
    for name in _UVICORN_LOGGERS:
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
