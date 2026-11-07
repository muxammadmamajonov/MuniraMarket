"""Cleanup of expired security state (ADR 0013).

Readers ignore expired rows on their own, so this job only reclaims space. It deletes in bounded
batches (``ctid IN (SELECT ... LIMIT n)``) so one run never holds long locks or a long
transaction, and it is safe to run concurrently or repeatedly. Triggered by the scheduler Worker
through ``POST /api/v1/internal/maintenance/cleanup`` (ADR 0015).
"""

from datetime import datetime
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

BATCH_SIZE: Final = 5000
MAX_BATCHES_PER_TABLE: Final = 20

# Static SQL per table (no string formatting of identifiers at runtime).
_EXPIRED_DELETES: Final[dict[str, str]] = {
    "auth_sessions": (
        "DELETE FROM auth_sessions WHERE ctid IN "
        "(SELECT ctid FROM auth_sessions WHERE expires_at <= :now LIMIT :batch)"
    ),
    "rate_limit_counters": (
        "DELETE FROM rate_limit_counters WHERE ctid IN "
        "(SELECT ctid FROM rate_limit_counters WHERE expires_at <= :now LIMIT :batch)"
    ),
    "service_request_nonces": (
        "DELETE FROM service_request_nonces WHERE ctid IN "
        "(SELECT ctid FROM service_request_nonces WHERE expires_at <= :now LIMIT :batch)"
    ),
    "oidc_login_states": (
        "DELETE FROM oidc_login_states WHERE ctid IN "
        "(SELECT ctid FROM oidc_login_states WHERE expires_at <= :now LIMIT :batch)"
    ),
}


async def delete_expired(session: AsyncSession, *, now: datetime) -> dict[str, int]:
    """Delete expired rows table by table; returns the number of rows removed per table."""
    removed: dict[str, int] = {}
    for table, statement in _EXPIRED_DELETES.items():
        total = 0
        for _ in range(MAX_BATCHES_PER_TABLE):
            result = await session.execute(
                text(statement),
                {"now": now, "batch": BATCH_SIZE},
            )
            await session.commit()
            count = int(getattr(result, "rowcount", 0) or 0)
            total += count
            if count < BATCH_SIZE:
                break
        removed[table] = total
    return removed
