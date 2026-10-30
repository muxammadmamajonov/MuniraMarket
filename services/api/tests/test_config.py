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


# --- sessions / CSRF / Login Widget (ADR 0007) ---------------------------------------------------

DEPLOYED = {"cors_allowed_origins": "https://shop.example", "telegram_environment": "production"}


def test_session_defaults() -> None:
    settings = make_settings()
    assert settings.session_cookie_secure is True
    assert settings.session_cookie_name == "__Host-mm_session"
    assert settings.session_idle_ttl_seconds == 7 * 86400
    assert settings.session_absolute_ttl_seconds == 30 * 86400
    assert settings.session_rotate_after_seconds == 86400
    assert settings.csrf_trusted_origins == []
    assert settings.telegram_login_widget_enabled is False
    assert settings.telegram_login_max_age_seconds == 600
    assert settings.session_rotation_grace_seconds == 60


@pytest.mark.parametrize("grace", [0, 1, 300])
def test_rotation_grace_bounds_accepted(grace: int) -> None:
    assert make_settings(session_rotation_grace_seconds=grace).session_rotation_grace_seconds == (
        grace
    )


@pytest.mark.parametrize("grace", [-1, 301, 86400])
def test_rotation_grace_bounds_rejected(grace: int) -> None:
    with pytest.raises(ValidationError, match="SESSION_ROTATION_GRACE_SECONDS"):
        make_settings(session_rotation_grace_seconds=grace)


def test_forwarded_allow_ips_parsing() -> None:
    settings = make_settings(forwarded_allow_ips=" 10.0.0.2 , 172.16.0.0/12,::1, fd00::/8 ")
    assert settings.forwarded_allow_ips == ["10.0.0.2", "172.16.0.0/12", "::1", "fd00::/8"]
    # Unset is fine locally: uvicorn then trusts only loopback.
    assert make_settings(forwarded_allow_ips="").forwarded_allow_ips == []
    assert make_settings(app_env="development", forwarded_allow_ips="*").forwarded_allow_ips == [
        "*"
    ]


@pytest.mark.parametrize(
    "value",
    [
        "proxy.internal",  # names are not resolved by uvicorn's trust check
        "10.0.0.1/8",  # host bits set: uvicorn would silently treat it as a literal
        "10.0.0.300",
        "10.0.0.2,unix:/tmp/sock",
    ],
)
def test_forwarded_allow_ips_must_be_ips_or_networks(value: str) -> None:
    with pytest.raises(ValidationError, match="FORWARDED_ALLOW_IPS entry"):
        make_settings(forwarded_allow_ips=value)


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_forwarded_allow_ips_required_and_not_wildcard_when_deployed(app_env: str) -> None:
    with pytest.raises(ValidationError, match=r"FORWARDED_ALLOW_IPS .*required"):
        make_settings(app_env=app_env, forwarded_allow_ips="", **DEPLOYED)
    with pytest.raises(ValidationError, match="FORWARDED_ALLOW_IPS must not contain"):
        make_settings(app_env=app_env, forwarded_allow_ips="10.0.0.2,*", **DEPLOYED)
    settings = make_settings(app_env=app_env, forwarded_allow_ips="10.0.0.2", **DEPLOYED)
    assert settings.forwarded_allow_ips == ["10.0.0.2"]


def test_forwarded_allow_ips_reads_the_uvicorn_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """The API validates exactly the variable uvicorn reads (no separate setting to drift)."""
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "10.9.8.7")
    values = {
        "app_env": "test",
        "database_url": "postgresql+asyncpg://fake:fake-password@127.0.0.1:1/fake",
        "redis_url": "redis://localhost:6379/0",
        "service_auth_keys": f"k:{'x' * 40}",
        "telegram_bot_id": 1,
    }
    for name, value in values.items():
        monkeypatch.setenv(name.upper(), str(value))
    assert Settings(_env_file=None).forwarded_allow_ips == ["10.9.8.7"]


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_insecure_cookie_allowed_only_for_local_envs(app_env: str) -> None:
    settings = make_settings(app_env=app_env, session_cookie_secure=False)
    assert settings.session_cookie_name == "mm_session"


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_secure_cookie_required_when_deployed(app_env: str) -> None:
    with pytest.raises(ValidationError, match="SESSION_COOKIE_SECURE"):
        make_settings(app_env=app_env, session_cookie_secure=False, **DEPLOYED)
    assert make_settings(app_env=app_env, **DEPLOYED).session_cookie_secure


def test_session_settings_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@localhost/db")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("SERVICE_AUTH_KEYS", f"local:{GOOD_SECRET}")
    monkeypatch.setenv("TELEGRAM_BOT_ID", "42")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("CSRF_TRUSTED_ORIGINS", "http://localhost:3000, https://Shop.Example/")
    settings = Settings(_env_file=None)
    assert settings.session_cookie_secure is False
    assert settings.csrf_trusted_origins == ["http://localhost:3000", "https://shop.example"]


@pytest.mark.parametrize(
    "field",
    [
        "session_idle_ttl_seconds",
        "session_absolute_ttl_seconds",
        "session_rotate_after_seconds",
        "telegram_login_max_age_seconds",
    ],
)
def test_durations_must_be_positive(field: str) -> None:
    with pytest.raises(ValidationError):
        make_settings(**{field: 0})


def test_idle_and_rotation_must_fit_in_absolute_lifetime() -> None:
    with pytest.raises(ValidationError, match="SESSION_IDLE_TTL_SECONDS"):
        make_settings(session_idle_ttl_seconds=100, session_absolute_ttl_seconds=50)
    with pytest.raises(ValidationError, match="SESSION_ROTATE_AFTER_SECONDS"):
        make_settings(
            session_idle_ttl_seconds=10,
            session_rotate_after_seconds=100,
            session_absolute_ttl_seconds=50,
        )


@pytest.mark.parametrize(
    "origins",
    [
        "*",
        "https://shop.example,*",
        "https://shop.example/path",
        "https://shop.example?x=1",
        "ftp://shop.example",
        "shop.example",
        "https://user:pw@shop.example",
    ],
)
def test_invalid_csrf_origins_rejected(origins: str) -> None:
    with pytest.raises(ValidationError, match="CSRF_TRUSTED_ORIGINS"):
        make_settings(csrf_trusted_origins=origins)


def test_csrf_origins_are_normalised() -> None:
    settings = make_settings(
        csrf_trusted_origins="HTTPS://Shop.Example:443,http://localhost:3000,http://[::1]:8080"
    )
    assert settings.csrf_trusted_origins == [
        "https://shop.example",
        "http://localhost:3000",
        "http://[::1]:8080",
    ]


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_https_csrf_origins_required_when_deployed(app_env: str) -> None:
    with pytest.raises(ValidationError, match="CSRF_TRUSTED_ORIGINS"):
        make_settings(app_env=app_env, csrf_trusted_origins="http://shop.example", **DEPLOYED)
    make_settings(app_env=app_env, csrf_trusted_origins="https://shop.example", **DEPLOYED)


def test_login_widget_requires_token_and_username() -> None:
    with pytest.raises(ValidationError, match="TELEGRAM_LOGIN_WIDGET_ENABLED"):
        make_settings(telegram_login_widget_enabled=True)
    with pytest.raises(ValidationError, match="TELEGRAM_LOGIN_WIDGET_ENABLED"):
        make_settings(telegram_login_widget_enabled=True, telegram_bot_token="1:fake-token")
    with pytest.raises(ValidationError, match="TELEGRAM_LOGIN_WIDGET_ENABLED"):
        make_settings(telegram_login_widget_enabled=True, telegram_bot_username="shop_test_bot")
    settings = make_settings(
        telegram_login_widget_enabled=True,
        telegram_bot_token="1:fake-token",
        telegram_bot_username="@shop_test_bot",
    )
    assert settings.telegram_bot_username == "shop_test_bot"


@pytest.mark.parametrize("username", ["abc", "has space", "x" * 33, "dash-bot"])
def test_bot_username_format(username: str) -> None:
    with pytest.raises(ValidationError, match="TELEGRAM_BOT_USERNAME"):
        make_settings(telegram_bot_username=username)
