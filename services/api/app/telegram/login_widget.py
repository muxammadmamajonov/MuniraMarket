"""Verification of Telegram Login Widget payloads (website sign-in, ADR 0007).

Telegram signs the widget fields with ``HMAC-SHA256(key=SHA256(bot_token))`` over the
data-check-string: every received field except ``hash`` as ``key=value``, sorted by key and
joined with ``\\n``. Unlike Mini App ``initData`` there is no Ed25519 alternative, so this path
requires ``TELEGRAM_BOT_TOKEN``.
"""

import hashlib
import hmac
import re
from collections.abc import Mapping
from typing import Final

from app.core.clock import Clock
from app.telegram.identity import MAX_FUTURE_SKEW_SECONDS, VerifiedTelegramIdentity

# The only fields the widget sends. Anything else is rejected rather than silently signed over.
ALLOWED_FIELDS: Final = frozenset(
    {"id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"}
)
_HASH_RE = re.compile(r"[0-9a-f]{64}")
_DIGITS_RE = re.compile(r"[0-9]{1,20}")
_MAX_NAME_LENGTH = 255
_MAX_USERNAME_LENGTH = 64


class InvalidLoginWidgetData(Exception):  # noqa: N818 - mirrors InvalidInitData
    """Widget payload failed verification. ``reason`` is a short, non-sensitive log label."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _optional(fields: Mapping[str, str], key: str, max_length: int) -> str | None:
    value = fields.get(key)
    if value is None:
        return None
    stripped = value.strip()
    return stripped[:max_length] if stripped else None


class LoginWidgetVerifier:
    def __init__(self, *, bot_token: str, max_age_seconds: int, clock: Clock) -> None:
        self._secret_key = hashlib.sha256(bot_token.encode("utf-8")).digest()
        self._max_age = max_age_seconds
        self._clock = clock

    def verify(self, fields: Mapping[str, str]) -> VerifiedTelegramIdentity:
        """Return the verified identity or raise :class:`InvalidLoginWidgetData`."""
        if not fields.keys() <= ALLOWED_FIELDS:
            raise InvalidLoginWidgetData("unknown_field")
        received = fields.get("hash", "")
        if not _HASH_RE.fullmatch(received):
            raise InvalidLoginWidgetData("hash_malformed")
        data_check_string = "\n".join(
            f"{key}={fields[key]}" for key in sorted(fields) if key != "hash"
        )
        expected = hmac.new(
            self._secret_key, data_check_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected.encode("ascii"), received.encode("ascii")):
            raise InvalidLoginWidgetData("hash_mismatch")

        raw_auth_date = fields.get("auth_date", "")
        if not _DIGITS_RE.fullmatch(raw_auth_date):
            raise InvalidLoginWidgetData("auth_date_invalid")
        auth_date = int(raw_auth_date)
        now = self._clock()
        if now - auth_date > self._max_age:
            raise InvalidLoginWidgetData("expired")
        if auth_date - now > MAX_FUTURE_SKEW_SECONDS:
            raise InvalidLoginWidgetData("auth_date_in_future")

        raw_id = fields.get("id", "")
        if not _DIGITS_RE.fullmatch(raw_id) or int(raw_id) <= 0:
            raise InvalidLoginWidgetData("user_id_invalid")
        first_name = _optional(fields, "first_name", _MAX_NAME_LENGTH)
        if first_name is None:
            raise InvalidLoginWidgetData("user_first_name_missing")
        return VerifiedTelegramIdentity(
            telegram_user_id=int(raw_id),
            first_name=first_name,
            last_name=_optional(fields, "last_name", _MAX_NAME_LENGTH),
            username=_optional(fields, "username", _MAX_USERNAME_LENGTH),
            language_code=None,
            auth_date=auth_date,
        )
