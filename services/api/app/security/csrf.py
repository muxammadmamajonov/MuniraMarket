"""CSRF defences for cookie-authenticated browser requests (ADR 0007).

Two independent checks for state-changing methods:

1. **Origin check.** ``Origin`` (or, if absent, the origin of ``Referer``) must be one of
   ``CSRF_TRUSTED_ORIGINS``. With neither header the request is rejected in staging/production
   and allowed in development/test (curl, test clients). Also applied to login endpoints, which
   have no session yet (login CSRF).
2. **Synchronizer token.** ``X-CSRF-Token`` must equal the token stored in the session.
"""

import hmac
from collections.abc import Collection, Mapping
from typing import Final

from app.core.config import AppEnv, normalize_origin

UNSAFE_METHODS: Final = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CSRF_HEADER: Final = "X-CSRF-Token"


class CsrfError(Exception):
    """``reason`` is a short label for logs; clients only ever see ``csrf_failed``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def is_unsafe_method(method: str) -> bool:
    return method.upper() in UNSAFE_METHODS


def check_origin(
    headers: Mapping[str, str], *, trusted_origins: Collection[str], app_env: AppEnv
) -> None:
    """Raise :class:`CsrfError` unless the request comes from a trusted origin."""
    origin = headers.get("origin")
    if origin is None:
        referer = headers.get("referer")
        if referer is None:
            if app_env in ("development", "test"):
                return
            raise CsrfError("origin_missing")
        origin = referer
    normalized = normalize_origin(origin)  # "null" and garbage normalise to None
    if normalized is None or normalized not in trusted_origins:
        raise CsrfError("origin_untrusted")


def check_token(expected: str, received: str | None) -> None:
    """Constant-time comparison of the session CSRF token with the request header."""
    if not received:
        raise CsrfError("token_missing")
    if not hmac.compare_digest(expected.encode("utf-8"), received.encode("utf-8")):
        raise CsrfError("token_mismatch")
