"""Injectable wall clock (seconds since the Unix epoch) so time-dependent code is testable."""

import time
from collections.abc import Callable

Clock = Callable[[], float]


def system_clock() -> float:
    return time.time()
