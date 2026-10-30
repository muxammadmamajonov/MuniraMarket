import pytest
from pydantic import ValidationError

from app.core.config import Settings, parse_service_auth_keys
from tests.conftest import make_settings

GOOD_SECRET = "s" * 32


def test_valid_settings_parse() -> None:
    settings = make_settings(
        cors_allowed_origins="https://a.example, https://b.example,",
        service_auth_keys=f"one:{GOOD_SECRET},two-2:{'t' * 40}",
        telegram_bot_token="123:fake-token",
    )
    assert settings.cors_allowed_origins == ["https://a.example", "https://b.example"]
    assert set(settings.parsed_service_auth_keys) == {"one", "two-2"}
    assert settings.parsed_service_auth_keys["one"].get_secret_value() == GOOD_SECRET
    assert settings.telegram_bot_token is not None
    assert settings.telegram_init_data_max_age_seconds == 3600
    assert settings.docs_enabled


def test_settings_load_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@localhost/db")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001")
    monkeypatch.setenv("SERVICE_AUTH_KEYS", f"local:{GOOD_SECRET}")
    monkeypatch.setenv("TELEGRAM_BOT_ID", "42")
    settings = Settings(_env_file=None)
    assert settings.cors_allowed_origins == ["http://localhost:3000", "http://localhost:3001"]
    assert settings.telegram_bot_id == 42


def test_missing_required_variables_fail_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("DATABASE_URL", "REDIS_URL", "SERVICE_AUTH_KEYS", "TELEGRAM_BOT_ID"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None)
    assert {error["loc"][0] for error in excinfo.value.errors()} >= {
        "database_url",
        "redis_url",
        "service_auth_keys",
        "telegram_bot_id",
    }


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://u:p@localhost/db",
        "postgresql+psycopg://u:p@localhost/db",
        "mysql+aiomysql://u:p@localhost/db",
        "not a url",
    ],
)
def test_database_url_must_use_asyncpg(url: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(database_url=url)


def test_redis_url_scheme_is_checked() -> None:
    with pytest.raises(ValidationError):
        make_settings(redis_url="http://localhost:6379")


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "no-separator",
        f":{GOOD_SECRET}",
        f"bad key:{GOOD_SECRET}",
        f"{'k' * 33}:{GOOD_SECRET}",
        "short:too-short",
        f"dup:{GOOD_SECRET},dup:{'x' * 32}",
        f"ok:{GOOD_SECRET},bad!:{GOOD_SECRET}",
    ],
)
def test_service_auth_keys_validation(raw: str) -> None:
    with pytest.raises(ValueError, match="SERVICE_AUTH_KEYS"):
        parse_service_auth_keys(raw)
    with pytest.raises(ValidationError):
        make_settings(service_auth_keys=raw)


def test_secret_may_contain_colons() -> None:
    keys = parse_service_auth_keys(f"k:{GOOD_SECRET}:with:colons")
    assert keys["k"].get_secret_value() == f"{GOOD_SECRET}:with:colons"


def test_validation_errors_never_echo_secrets() -> None:
    secret_marker = "very-secret-marker-value-1234567890"
    with pytest.raises(ValidationError) as excinfo:
        make_settings(
            database_url=f"mysql://user:{secret_marker}@localhost/db",
            service_auth_keys=f"bad key:{secret_marker}",
        )
    # str() is what ends up in startup logs; hide_input_in_errors keeps raw values out of it.
    assert secret_marker not in str(excinfo.value)


@pytest.mark.parametrize("app_env", ["development", "test", "staging", "production"])
def test_wildcard_cors_is_rejected_everywhere(app_env: str) -> None:
    with pytest.raises(ValidationError, match="CORS_ALLOWED_ORIGINS"):
        make_settings(app_env=app_env, cors_allowed_origins="*", telegram_environment="production")
    with pytest.raises(ValidationError, match="CORS_ALLOWED_ORIGINS"):
        make_settings(
            app_env=app_env,
            cors_allowed_origins="https://shop.example,*",
            telegram_environment="production",
        )


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_https_origins_required_outside_development(app_env: str) -> None:
    with pytest.raises(ValidationError, match="https"):
        make_settings(
            app_env=app_env,
            cors_allowed_origins="https://shop.example,http://shop.example",
            telegram_environment="production",
        )
    make_settings(
        app_env=app_env,
        cors_allowed_origins="https://shop.example",
        telegram_environment="production",
    )


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_http_origins_allowed_in_development_and_test(app_env: str) -> None:
    make_settings(app_env=app_env, cors_allowed_origins="http://localhost:3000")


def test_app_env_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@localhost/db")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("SERVICE_AUTH_KEYS", f"local:{GOOD_SECRET}")
    monkeypatch.setenv("TELEGRAM_BOT_ID", "42")
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=None)
    assert [error["loc"] for error in excinfo.value.errors()] == [("app_env",)]


def test_test_telegram_environment_is_rejected_in_production() -> None:
    with pytest.raises(ValidationError, match="TELEGRAM_ENVIRONMENT"):
        make_settings(
            app_env="production",
            cors_allowed_origins="https://shop.example",
            telegram_environment="test",
        )
    make_settings(app_env="staging", cors_allowed_origins="https://shop.example")


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_bot_id_must_be_set_outside_development(app_env: str) -> None:
    with pytest.raises(ValidationError, match="TELEGRAM_BOT_ID"):
        make_settings(app_env=app_env, telegram_bot_id=0, telegram_environment="production")


def test_invalid_enums_and_ages_are_rejected() -> None:
    with pytest.raises(ValidationError):
        make_settings(app_env="prod")
    with pytest.raises(ValidationError):
        make_settings(telegram_environment="staging")
    with pytest.raises(ValidationError):
        make_settings(telegram_init_data_max_age_seconds=0)


@pytest.mark.parametrize(
    ("app_env", "enabled"),
    [
        ("development", True),
        ("test", True),
        ("staging", False),
        ("production", False),
    ],
)
def test_docs_only_enabled_for_development_and_test(app_env: str, enabled: bool) -> None:
    settings = make_settings(
        app_env=app_env,
        cors_allowed_origins="https://shop.example",
        telegram_environment="production",
    )
    assert settings.docs_enabled is enabled
