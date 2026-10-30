"""Verification of Telegram Mini App ``initData``.

Two interchangeable verifiers implement :class:`TelegramIdentityVerifier`:

* :class:`Ed25519InitDataVerifier` - Telegram "third-party validation". Needs only the bot *id*
  and Telegram's published public key, so the bot token never has to reach this service.
  This is the default.
* :class:`HmacInitDataVerifier` - classic validation with the bot token. Used only when
  ``TELEGRAM_BOT_TOKEN`` is configured.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Final, Protocol
from urllib.parse import parse_qsl

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from app.core.clock import Clock

# Telegram's published Ed25519 public keys for third-party validation (hex).
TELEGRAM_PUBLIC_KEYS: Final[dict[str, str]] = {
    "production": "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d",
    "test": "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec",
}

MAX_FUTURE_SKEW_SECONDS: Final = 60
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_ED25519_SIGNATURE_BYTES = 64
_MAX_NAME_LENGTH = 255
_MAX_USERNAME_LENGTH = 64
_MAX_LANGUAGE_CODE_LENGTH = 16


class InvalidInitData(Exception):  # noqa: N818 - name fixed by the API contract
    """``initData`` failed verification. ``reason`` is a short, non-sensitive label for logs."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class VerifiedTelegramIdentity:
    telegram_user_id: int
    first_name: str
    last_name: str | None
    username: str | None
    language_code: str | None
    auth_date: int


class TelegramIdentityVerifier(Protocol):
    def verify(self, init_data: str) -> VerifiedTelegramIdentity:
        """Return the verified identity or raise :class:`InvalidInitData`."""
        ...


def _optional_str(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidInitData("user_field_type")
    stripped = value.strip()
    return stripped[:max_length] if stripped else None


class _BaseVerifier(ABC):
    def __init__(self, *, max_age_seconds: int, clock: Clock) -> None:
        self._max_age = max_age_seconds
        self._clock = clock

    def verify(self, init_data: str) -> VerifiedTelegramIdentity:
        fields = self._parse(init_data)
        self._check_signature(fields)
        auth_date = self._check_auth_date(fields)
        return self._build_identity(fields, auth_date)

    @abstractmethod
    def _check_signature(self, fields: dict[str, str]) -> None: ...

    @staticmethod
    def _parse(init_data: str) -> dict[str, str]:
        try:
            pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            raise InvalidInitData("malformed") from None
        fields: dict[str, str] = {}
        for key, value in pairs:
            if key in fields:
                raise InvalidInitData("duplicate_key")
            fields[key] = value
        return fields

    @staticmethod
    def _data_check_string(fields: dict[str, str], *, exclude: frozenset[str]) -> str:
        return "\n".join(f"{key}={fields[key]}" for key in sorted(fields) if key not in exclude)

    def _check_auth_date(self, fields: dict[str, str]) -> int:
        raw = fields.get("auth_date")
        if raw is None or not raw.isascii() or not raw.isdigit():
            raise InvalidInitData("auth_date_invalid")
        auth_date = int(raw)
        now = self._clock()
        if now - auth_date > self._max_age:
            raise InvalidInitData("expired")
        if auth_date - now > MAX_FUTURE_SKEW_SECONDS:
            raise InvalidInitData("auth_date_in_future")
        return auth_date

    @staticmethod
    def _build_identity(fields: dict[str, str], auth_date: int) -> VerifiedTelegramIdentity:
        raw_user = fields.get("user")
        if raw_user is None:
            raise InvalidInitData("user_missing")
        try:
            user = json.loads(raw_user)
        except ValueError:
            raise InvalidInitData("user_malformed") from None
        if not isinstance(user, dict):
            raise InvalidInitData("user_malformed")
        user_id = user.get("id")
        if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
            raise InvalidInitData("user_id_invalid")
        first_name = _optional_str(user.get("first_name"), max_length=_MAX_NAME_LENGTH)
        if first_name is None:
            raise InvalidInitData("user_first_name_missing")
        return VerifiedTelegramIdentity(
            telegram_user_id=user_id,
            first_name=first_name,
            last_name=_optional_str(user.get("last_name"), max_length=_MAX_NAME_LENGTH),
            username=_optional_str(user.get("username"), max_length=_MAX_USERNAME_LENGTH),
            language_code=_optional_str(
                user.get("language_code"), max_length=_MAX_LANGUAGE_CODE_LENGTH
            ),
            auth_date=auth_date,
        )


class Ed25519InitDataVerifier(_BaseVerifier):
    """Third-party validation: Ed25519 signature over ``<bot_id>:WebAppData\\n<fields>``."""

    def __init__(
        self,
        *,
        bot_id: int,
        public_key_hex: str,
        max_age_seconds: int,
        clock: Clock,
    ) -> None:
        super().__init__(max_age_seconds=max_age_seconds, clock=clock)
        self._bot_id = bot_id
        self._public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))

    def _check_signature(self, fields: dict[str, str]) -> None:
        signature = fields.get("signature")
        if not signature or not _B64URL_RE.fullmatch(signature):
            raise InvalidInitData("signature_malformed")
        try:
            raw_signature = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        except (binascii.Error, ValueError):
            raise InvalidInitData("signature_malformed") from None
        if len(raw_signature) != _ED25519_SIGNATURE_BYTES:
            raise InvalidInitData("signature_malformed")
        message = f"{self._bot_id}:WebAppData\n" + self._data_check_string(
            fields, exclude=frozenset({"hash", "signature"})
        )
        try:
            self._public_key.verify(raw_signature, message.encode("utf-8"))
        except InvalidSignature:
            raise InvalidInitData("signature_mismatch") from None


class HmacInitDataVerifier(_BaseVerifier):
    """Bot-token validation: ``hash`` = HMAC-SHA256(HMAC-SHA256("WebAppData", token), fields)."""

    def __init__(self, *, bot_token: str, max_age_seconds: int, clock: Clock) -> None:
        super().__init__(max_age_seconds=max_age_seconds, clock=clock)
        self._secret_key = hmac.new(
            b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256
        ).digest()

    def _check_signature(self, fields: dict[str, str]) -> None:
        received = fields.get("hash")
        if not received:
            raise InvalidInitData("hash_missing")
        data_check_string = self._data_check_string(fields, exclude=frozenset({"hash"}))
        expected = hmac.new(
            self._secret_key, data_check_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected.encode("ascii"), received.encode("utf-8")):
            raise InvalidInitData("hash_mismatch")
