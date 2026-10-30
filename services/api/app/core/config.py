"""Environment-driven settings, validated eagerly so a bad deployment fails at startup."""

import re
from functools import lru_cache
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

AppEnv = Literal["development", "test", "staging", "production"]
TelegramEnvironment = Literal["production", "test"]

_KEY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
# Telegram bot usernames: 5-32 characters, letters, digits and underscores.
_BOT_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{5,32}$")
MIN_SERVICE_SECRET_BYTES = 32
_ASYNCPG_SCHEME = "postgresql+asyncpg"
_DEFAULT_PORTS = {"http": 80, "https": 443}

DAY_SECONDS = 24 * 60 * 60


def normalize_origin(value: str) -> str | None:
    """Return ``scheme://host[:port]`` (lower-case, default port dropped) or ``None``.

    Used both for configured trusted origins and for ``Origin``/``Referer`` request headers, so
    the two sides always compare in the same canonical form.
    """
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host or parts.username or parts.password:
        return None
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    if port is None or port == _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def parse_service_auth_keys(raw: str) -> dict[str, SecretStr]:
    """Parse ``key_id:secret[,key_id:secret]`` (ADR 0003). Error messages never echo secrets."""
    keys: dict[str, SecretStr] = {}
    entries = [entry.strip() for entry in raw.split(",") if entry.strip()]
    if not entries:
        raise ValueError("SERVICE_AUTH_KEYS must contain at least one key_id:secret pair")
    for position, entry in enumerate(entries, start=1):
        key_id, separator, secret = entry.partition(":")
        if not separator:
            raise ValueError(f"SERVICE_AUTH_KEYS entry {position} must look like key_id:secret")
        if not _KEY_ID_RE.fullmatch(key_id):
            raise ValueError(f"SERVICE_AUTH_KEYS entry {position} has an invalid key id")
        if len(secret.encode("utf-8")) < MIN_SERVICE_SECRET_BYTES:
            raise ValueError(
                f"SERVICE_AUTH_KEYS entry {position} secret must be at least "
                f"{MIN_SERVICE_SECRET_BYTES} bytes"
            )
        if key_id in keys:
            raise ValueError(f"SERVICE_AUTH_KEYS contains a duplicate key id (entry {position})")
        keys[key_id] = SecretStr(secret)
    return keys


class Settings(BaseSettings):
    """Core API configuration. Field names map 1:1 to upper-case environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # Never echo rejected input (it may be a secret or a URL with a password).
        hide_input_in_errors=True,
    )

    app_env: AppEnv  # required: no default, so a missing APP_ENV fails fast
    database_url: SecretStr
    redis_url: SecretStr
    cors_allowed_origins: Annotated[list[str], NoDecode] = []
    service_auth_keys: SecretStr
    telegram_bot_id: int
    telegram_init_data_max_age_seconds: int = 3600
    telegram_environment: TelegramEnvironment = "production"
    # Optional. When set, the HMAC (bot token) init-data path replaces Ed25519 verification.
    telegram_bot_token: SecretStr | None = None

    # Browser sessions (ADR 0007).
    session_cookie_secure: bool = True
    session_idle_ttl_seconds: int = 7 * DAY_SECONDS
    session_absolute_ttl_seconds: int = 30 * DAY_SECONDS
    session_rotate_after_seconds: int = DAY_SECONDS
    # Origins allowed to send state-changing requests (CSRF Origin check). Normalised to
    # ``scheme://host[:port]``.
    csrf_trusted_origins: Annotated[list[str], NoDecode] = []

    # Telegram Login Widget for the website. Off by default; needs the bot token and username.
    telegram_login_widget_enabled: bool = False
    telegram_bot_username: str | None = None
    telegram_login_max_age_seconds: int = DAY_SECONDS

    @field_validator("cors_allowed_origins", "csrf_trusted_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("csrf_trusted_origins")
    @classmethod
    def _normalize_trusted_origins(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for position, raw in enumerate(value, start=1):
            if raw == "*":
                raise ValueError("CSRF_TRUSTED_ORIGINS must not contain '*'")
            parts = urlsplit(raw)
            origin = normalize_origin(raw)
            if origin is None or parts.path not in ("", "/") or parts.query or parts.fragment:
                raise ValueError(
                    f"CSRF_TRUSTED_ORIGINS entry {position} must look like scheme://host[:port]"
                )
            normalized.append(origin)
        return normalized

    @field_validator("telegram_bot_username", mode="before")
    @classmethod
    def _strip_bot_username(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip().removeprefix("@")
            return stripped or None
        return value

    @field_validator("telegram_bot_username")
    @classmethod
    def _check_bot_username(cls, value: str | None) -> str | None:
        if value is not None and not _BOT_USERNAME_RE.fullmatch(value):
            raise ValueError("TELEGRAM_BOT_USERNAME must be 5-32 letters, digits or underscores")
        return value

    @field_validator(
        "session_idle_ttl_seconds",
        "session_absolute_ttl_seconds",
        "session_rotate_after_seconds",
        "telegram_login_max_age_seconds",
    )
    @classmethod
    def _check_positive_durations(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("session and login durations must be positive")
        return value

    @field_validator("database_url")
    @classmethod
    def _check_database_url(cls, value: SecretStr) -> SecretStr:
        try:
            url = make_url(value.get_secret_value())
        except ArgumentError:
            raise ValueError("DATABASE_URL is not a valid SQLAlchemy URL") from None
        if url.drivername != _ASYNCPG_SCHEME:
            raise ValueError(f"DATABASE_URL must use the {_ASYNCPG_SCHEME}:// scheme")
        return value

    @field_validator("redis_url")
    @classmethod
    def _check_redis_url(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().startswith(("redis://", "rediss://", "unix://")):
            raise ValueError("REDIS_URL must start with redis://, rediss:// or unix://")
        return value

    @field_validator("service_auth_keys")
    @classmethod
    def _check_service_auth_keys(cls, value: SecretStr) -> SecretStr:
        parse_service_auth_keys(value.get_secret_value())
        return value

    @field_validator("telegram_init_data_max_age_seconds")
    @classmethod
    def _check_max_age(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("TELEGRAM_INIT_DATA_MAX_AGE_SECONDS must be positive")
        return value

    @model_validator(mode="after")
    def _check_environment_rules(self) -> Self:
        if "*" in self.cors_allowed_origins:
            raise ValueError("CORS_ALLOWED_ORIGINS must not contain '*'")
        if self.app_env in ("staging", "production"):
            insecure = [o for o in self.cors_allowed_origins if not o.startswith("https://")]
            if insecure:
                raise ValueError(
                    "CORS_ALLOWED_ORIGINS must be https:// origins outside development"
                )
        if self.app_env == "production" and self.telegram_environment == "test":
            raise ValueError("TELEGRAM_ENVIRONMENT=test is not allowed when APP_ENV=production")
        if self.app_env in ("staging", "production") and self.telegram_bot_id <= 0:
            raise ValueError("TELEGRAM_BOT_ID must be a positive integer outside development")
        self._check_session_rules()
        self._check_login_widget_rules()
        return self

    def _check_session_rules(self) -> None:
        deployed = self.app_env in ("staging", "production")
        if deployed and not self.session_cookie_secure:
            raise ValueError(
                "SESSION_COOKIE_SECURE=false is only allowed when APP_ENV is development or test"
            )
        if deployed:
            insecure = [o for o in self.csrf_trusted_origins if not o.startswith("https://")]
            if insecure:
                raise ValueError(
                    "CSRF_TRUSTED_ORIGINS must be https:// origins outside development"
                )
        if self.session_idle_ttl_seconds > self.session_absolute_ttl_seconds:
            raise ValueError(
                "SESSION_IDLE_TTL_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS"
            )
        if self.session_rotate_after_seconds > self.session_absolute_ttl_seconds:
            raise ValueError(
                "SESSION_ROTATE_AFTER_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS"
            )

    def _check_login_widget_rules(self) -> None:
        if not self.telegram_login_widget_enabled:
            return
        if self.telegram_bot_token is None or self.telegram_bot_username is None:
            raise ValueError(
                "TELEGRAM_LOGIN_WIDGET_ENABLED=true requires TELEGRAM_BOT_TOKEN and "
                "TELEGRAM_BOT_USERNAME"
            )

    @property
    def session_cookie_name(self) -> str:
        # The __Host- prefix makes browsers insist on Secure, Path=/ and no Domain attribute.
        return "__Host-mm_session" if self.session_cookie_secure else "mm_session"

    @property
    def parsed_service_auth_keys(self) -> dict[str, SecretStr]:
        return parse_service_auth_keys(self.service_auth_keys.get_secret_value())

    @property
    def docs_enabled(self) -> bool:
        return self.app_env in ("development", "test")


@lru_cache
def get_settings() -> Settings:
    return Settings()
