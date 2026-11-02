"""Warehouse integration seam: value objects and the connector port, as pure typing only.

See ``architecture/0012-warehouse-integration-boundary.md``. Only the Core API talks to an
external warehouse, through an implementation of :class:`WarehouseConnector`; browsers never do.
Until the vendor contract exists nothing implements this protocol and nothing imports this
module: it changes no behaviour (a test keeps it unwired). Credentials never appear here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ExternalItemRef:
    """One product SKU mapped to exactly one external warehouse item id."""

    sku: str
    external_item_id: str


@dataclass(frozen=True, slots=True)
class StockLevel:
    """Availability of one item as reported by the warehouse at ``as_of``."""

    item: ExternalItemRef
    available_quantity: int
    as_of: datetime


@dataclass(frozen=True, slots=True)
class ReservationLine:
    sku: str
    quantity: int


@dataclass(frozen=True, slots=True)
class ReservationRequest:
    """Reserve stock for one order attempt; ``idempotency_key`` repeats on every retry."""

    order_id: str
    idempotency_key: str
    lines: tuple[ReservationLine, ...]


@dataclass(frozen=True, slots=True)
class ReservationResult:
    reservation_id: str
    idempotency_key: str


class WarehouseConnector(Protocol):
    """Port to the external warehouse. Every mutating call is idempotent by its key."""

    async def fetch_stock(self, skus: Sequence[str]) -> Sequence[StockLevel]: ...

    async def reserve(self, request: ReservationRequest) -> ReservationResult: ...

    async def commit(self, reservation_id: str, idempotency_key: str) -> None: ...

    async def cancel(self, reservation_id: str, idempotency_key: str) -> None: ...
