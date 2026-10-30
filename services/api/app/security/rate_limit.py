"""Fixed-window rate limiting (ADR 0007).

One counter per ``(scope, subject, window)``: ``INCR`` plus ``EXPIRE ... NX`` in a single
``MULTI`` transaction under ``mm:rl:<scope>:<subject>:<window_start>``. Store failures raise
:class:`StoreUnavailableError` so callers fail closed.
"""

import math
from dataclasses import dataclass
from typing import Final, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.clock import Clock
from app.security.session import StoreUnavailableError

RATE_LIMIT_KEY_PREFIX: Final = "mm:rl"


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
    return f"{RATE_LIMIT_KEY_PREFIX}:{scope}:{subject}:{window_start}"


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


class RedisRateLimiter:
    def __init__(self, client: Redis, clock: Clock) -> None:
        self._client = client
        self._clock = clock

    async def hit(
        self, scope: str, subject: str, *, limit: int, window_seconds: int
    ) -> RateLimitDecision:
        now = self._clock()
        window_start, retry_after = _window(now, window_seconds)
        key = rate_limit_key(scope, subject, window_start)
        try:
            async with self._client.pipeline(transaction=True) as pipe:
                pipe.incr(key)
                # NX: only the request that created the counter sets its expiry.
                pipe.expire(key, window_seconds, nx=True)
                count, _ = await pipe.execute()
        except RedisError:
            raise StoreUnavailableError from None
        return RateLimitDecision(allowed=int(count) <= limit, retry_after_seconds=retry_after)
