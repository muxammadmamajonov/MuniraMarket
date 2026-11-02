"""The warehouse seam (ADR 0012) is typing only and intentionally not wired anywhere yet."""

import dataclasses
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.domain import warehouse
from app.domain.warehouse import (
    ExternalItemRef,
    ReservationLine,
    ReservationRequest,
    ReservationResult,
    StockLevel,
)

APP_DIR = Path(__file__).resolve().parent.parent / "app"
SEAM = APP_DIR / "domain" / "warehouse.py"


def test_value_objects_are_frozen() -> None:
    ref = ExternalItemRef(sku="DEMO-1", external_item_id="ext-1")
    values = [
        ref,
        StockLevel(item=ref, available_quantity=3, as_of=datetime.now(UTC)),
        ReservationLine(sku="DEMO-1", quantity=1),
        ReservationRequest(
            order_id="o1", idempotency_key="k1", lines=(ReservationLine("DEMO-1", 1),)
        ),
        ReservationResult(reservation_id="r1", idempotency_key="k1"),
    ]
    for value in values:
        assert dataclasses.is_dataclass(value)
        field = dataclasses.fields(value)[0].name
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(value, field, "changed")


def test_connector_protocol_declares_the_four_operations() -> None:
    for name in ("fetch_stock", "reserve", "commit", "cancel"):
        assert callable(getattr(warehouse.WarehouseConnector, name))


def test_warehouse_seam_is_intentionally_unwired() -> None:
    """Nothing outside domain/warehouse.py may import it until the integration is built."""
    offenders = [
        str(path.relative_to(APP_DIR))
        for path in APP_DIR.rglob("*.py")
        if path != SEAM
        and "warehouse" in path.read_text(encoding="utf-8").lower()
        and (
            "domain.warehouse" in path.read_text(encoding="utf-8")
            or "import warehouse" in path.read_text(encoding="utf-8")
        )
    ]
    assert offenders == []
