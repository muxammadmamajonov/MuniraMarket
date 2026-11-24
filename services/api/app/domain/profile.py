"""The customer's own profile (``PATCH /me``) and saved addresses: pure rules, no I/O.

- Phone: an Uzbekistan number typed by the customer. Spaces, ``-``, ``(`` and ``)`` are ignored;
  ``+998XXXXXXXXX``, ``998XXXXXXXXX`` and the 9 national digits are accepted and stored as
  ``+998XXXXXXXXX``. A typed number is never *verified*: only the user's own shared Telegram
  contact (or an OTP) verifies a phone.
- Birth date: ``YYYY-MM-DD``, from 1900-01-01 up to today in Asia/Tashkent.
- Saved addresses: at most ``MAX_SAVED_ADDRESSES`` per user.
"""

import re
from datetime import UTC, date, datetime
from typing import Final

from app.domain.tashkent import tashkent_date

MAX_SAVED_ADDRESSES: Final = 10

MIN_BIRTH_DATE: Final = date(1900, 1, 1)
# ASCII digits only (``\d`` would also accept e.g. Arabic-Indic or fullwidth digits).
_BIRTH_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_PROFILE_PHONE_SEPARATORS = re.compile(r"[\s\-()]")
_PROFILE_PHONE_RE = re.compile(r"(?:\+?998)?([0-9]{9})")

PROFILE_PHONE_MESSAGE: Final = (
    "phone must be an Uzbekistan number: +998 and 9 digits, or the 9 digits alone"
)
BIRTH_DATE_FORMAT_MESSAGE: Final = "birth_date must be a date in YYYY-MM-DD format"
BIRTH_DATE_RANGE_MESSAGE: Final = "birth_date must be between 1900-01-01 and today"


def normalize_profile_phone(raw: str) -> str:
    """``(90) 123-45-67`` / ``998901234567`` / ``+998 90 123 45 67`` -> ``+998901234567``.

    Raises ``ValueError`` for anything else.
    """
    compact = _PROFILE_PHONE_SEPARATORS.sub("", raw)
    match = _PROFILE_PHONE_RE.fullmatch(compact)
    if match is None:
        raise ValueError(PROFILE_PHONE_MESSAGE)
    return f"+998{match.group(1)}"


def parse_birth_date(raw: object) -> date:
    """A ``YYYY-MM-DD`` string as a calendar date. Raises ``ValueError`` otherwise."""
    if not isinstance(raw, str) or not _BIRTH_DATE_RE.fullmatch(raw):
        raise ValueError(BIRTH_DATE_FORMAT_MESSAGE)
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValueError(BIRTH_DATE_FORMAT_MESSAGE) from None


def tashkent_today(now: datetime | None = None) -> date:
    return tashkent_date(now if now is not None else datetime.now(UTC))


def check_birth_date(value: date, *, today: date) -> date:
    """``value`` when it lies in 1900-01-01..``today`` (inclusive), else ``ValueError``."""
    if not MIN_BIRTH_DATE <= value <= today:
        raise ValueError(BIRTH_DATE_RANGE_MESSAGE)
    return value
