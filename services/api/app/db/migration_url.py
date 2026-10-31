"""Database URL for the one-off migration job.

Deployed environments run migrations as a separate, short-lived job with the **migration role**
(DDL rights), never with the runtime role the API uses (infra/neon/README.md). That job only
needs ``APP_ENV`` and ``MIGRATION_DATABASE_URL``; it does not get the API's other secrets
(service keys, bot token, Redis). Locally, when ``MIGRATION_DATABASE_URL`` is unset, Alembic
falls back to the application's ``DATABASE_URL`` exactly as before.
"""

import os
from collections.abc import Mapping

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from app.core.config import DEPLOYED_ENVS, get_settings

_TLS_SSL_MODES = frozenset({"require", "verify-ca", "verify-full"})


def migration_database_url(environ: Mapping[str, str] = os.environ) -> str:
    raw = environ.get("MIGRATION_DATABASE_URL", "").strip()
    if not raw:
        return get_settings().database_url.get_secret_value()
    try:
        url = make_url(raw)
    except ArgumentError:
        raise ValueError("MIGRATION_DATABASE_URL is not a valid SQLAlchemy URL") from None
    if url.drivername != "postgresql+asyncpg":
        raise ValueError("MIGRATION_DATABASE_URL must use the postgresql+asyncpg:// scheme")
    if "sslmode" in url.query:
        raise ValueError("MIGRATION_DATABASE_URL must use ssl= (asyncpg), not sslmode=")
    app_env = environ.get("APP_ENV", "").strip()
    if not app_env:
        raise ValueError("APP_ENV is required for migrations")
    if app_env in DEPLOYED_ENVS and url.query.get("ssl") not in _TLS_SSL_MODES:
        raise ValueError("MIGRATION_DATABASE_URL must set ssl=require outside development")
    return raw
