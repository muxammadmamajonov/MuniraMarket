"""Fixed-window rate limiting (ADR 0007).

One counter per ``(scope, subject, window)`` in ``rate_limit_counters`` (ADR 0013), keyed
``<scope>:<subject>:<window_start>``. A hit is one atomic ``INSERT ... ON CONFLICT DO UPDATE SET
hits = hits + 1 RETURNING hits``: concurrent requests serialise on the row lock, so no hit is lost
and no two requests see the same count. Store failures raise :class:`StoreUnavailableError` so
callers fail closed.
"""

import math
from dataclasses import dataclass
from typing import Final, Protocol

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.models.security_state import RateLimitCounter
from app.security.errors import StoreUnavailableError
from app.security.pg import SessionFactory, as_datetime, in_transaction

__all__ = ["StoreUnavailableError"]


@dataclass(frozen=True, slots=True)
class RateLimitRule:
    scope: str
    limit: int
    window_seconds: int


# Limits from the phase 2 spec. Routes pass these to ``app.api.auth_deps.rate_limit``.
AUTH_LOGIN: Final = RateLimitRule("auth_login", 10, 60)  # per IP
AUTH_SESSION: Final = RateLimitRule("auth_session", 60, 60)  # per IP
CART_READ: Final = RateLimitRule("cart_read", 120, 60)  # per user
CART_WRITE: Final = RateLimitRule("cart_write", 60, 60)  # per user
# Per-IP ceilings checked before any session or database work, so unauthenticated floods are
# cut off cheaply (ADR 0007).
CART_IP: Final = RateLimitRule("cart_ip", 300, 60)  # per IP, every /cart route
CATALOG_IP: Final = RateLimitRule("catalog_ip", 300, 60)  # per IP, public catalog reads
# Checkout and orders (phase 3). The IP ceiling covers every /checkout and /orders route.
ORDERS_IP: Final = RateLimitRule("orders_ip", 300, 60)  # per IP
CHECKOUT_QUOTE: Final = RateLimitRule("checkout_quote", 60, 60)  # per user
ORDER_CREATE: Final = RateLimitRule("order_create", 10, 60)  # per user
ORDER_READ: Final = RateLimitRule("order_read", 120, 60)  # per user
ORDER_CANCEL: Final = RateLimitRule("order_cancel", 20, 60)  # per user
# Operator/admin back office.
ADMIN_IP: Final = RateLimitRule("admin_ip", 600, 60)  # per IP
ADMIN_READ: Final = RateLimitRule("admin_read", 300, 60)  # per user
ADMIN_WRITE: Final = RateLimitRule("admin_write", 120, 60)  # per user
# Catalog CSV (admin only); on top of admin_ip and admin_write.
ADMIN_CSV_IMPORT: Final = RateLimitRule("admin_csv_import", 10, 60)  # per user
ADMIN_CSV_EXPORT: Final = RateLimitRule("admin_csv_export", 20, 60)  # per user


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    allowed: bool
    # Seconds until the current window ends (>= 1); meaningful when ``allowed`` is False.
    retry_after_seconds: int


class RateLimiter(Protocol):
    async def hit(
        self, scope: str, subject: str, *, limit: int, window_seconds: int
    ) -> RateLimitDecision:
        """Count one request and say whether it is within the limit."""
        ...


def _window(now: float, window_seconds: int) -> tuple[int, int]:
    """Return ``(window_start, retry_after)`` for the fixed window containing ``now``."""
    window_start = int(now // window_seconds) * window_seconds
    retry_after = max(1, math.ceil(window_start + window_seconds - now))
    return window_start, retry_after


def rate_limit_key(scope: str, subject: str, window_start: int) -> str:
    # The subject is an IP or a user id; scopes are short identifiers (``auth_deps.rate_limit``).
    return f"{scope}:{subject}:{window_start}"


class InMemoryRateLimiter:
    """Process-local limiter for tests (``APP_ENV=test``)."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._counters: dict[str, tuple[int, float]] = {}

    async def hit(
        self, scope: str, subject: str, *, limit: int, window_seconds: int
    ) -> RateLimitDecision:
        now = self._clock()
        self._counters = {k: v for k, v in self._counters.items() if v[1] > now}
        window_start, retry_after = _window(now, window_seconds)
        key = rate_limit_key(scope, subject, window_start)
        count, expires_at = self._counters.get(key, (0, now + window_seconds))
        count += 1
        self._counters[key] = (count, expires_at)
        return RateLimitDecision(allowed=count <= limit, retry_after_seconds=retry_after)


class PostgresRateLimiter:
    def __init__(self, factory: SessionFactory, clock: Clock) -> None:
        self._factory = factory
        self._clock = clock

    async def hit(
        self, scope: str, subject: str, *, limit: int, window_seconds: int
    ) -> RateLimitDecision:
        now = self._clock()
        window_start, retry_after = _window(now, window_seconds)
        bucket = rate_limit_key(scope, subject, window_start)
        # The row outlives its window by one window, which is plenty for the cleanup job.
        expires_at = as_datetime(window_start + 2 * window_seconds)

        async def work(db: AsyncSession) -> int:
            statement = pg_insert(RateLimitCounter).values(
                bucket=bucket, hits=1, expires_at=expires_at
            )
            count: int = (
                await db.execute(
                    statement.on_conflict_do_update(
                        index_elements=[RateLimitCounter.bucket],
                        set_={"hits": RateLimitCounter.hits + 1},
                    ).returning(RateLimitCounter.hits)
                )
            ).scalar_one()
            return count

        count = await in_transaction(self._factory, work)
        return RateLimitDecision(allowed=count <= limit, retry_after_seconds=retry_after)
