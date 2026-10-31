"""Turn the connection string Neon hands out into the one the API accepts.

``neon deploy`` / ``neon env pull`` write libpq-style URLs (``postgresql://…?sslmode=require&
channel_binding=require``). The API talks to PostgreSQL through asyncpg and refuses ``sslmode=``
(app.core.config), so the URL is rewritten to ``postgresql+asyncpg://…?ssl=verify-full``: the
certificate chain and hostname are checked, not just encrypted. Use the **direct** endpoint
(``DATABASE_URL_UNPOOLED``): the API keeps its own pool and uses prepared statements, which a
transaction-mode pooler does not suit (infra/neon/README.md).
"""

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from app.core.config import DEPLOYED_SSL_MODE

# libpq-only parameters asyncpg would reject as unknown connect() keywords.
_LIBPQ_ONLY_PARAMS = frozenset({"sslmode", "channel_binding", "sslrootcert", "options"})


def asyncpg_url_from_neon(raw: str) -> str:
    try:
        url: URL = make_url(raw.strip())
    except ArgumentError:
        raise ValueError("not a valid PostgreSQL URL") from None
    if url.drivername not in ("postgres", "postgresql", "postgresql+asyncpg"):
        raise ValueError("expected a postgresql:// URL")
    if url.host and "-pooler." in url.host:
        raise ValueError("use the direct endpoint (DATABASE_URL_UNPOOLED), not the pooler")
    query = {key: value for key, value in url.query.items() if key not in _LIBPQ_ONLY_PARAMS}
    query["ssl"] = DEPLOYED_SSL_MODE
    converted = url.set(drivername="postgresql+asyncpg", query=query)
    return converted.render_as_string(hide_password=False)
