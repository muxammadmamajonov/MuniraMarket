"""Append-only audit log of back-office changes.

``record_audit`` adds one ``audit_log`` row to the caller's session, so it commits or rolls back
together with the change it describes. Callers pass field changes as ``{field: (before, after)}``;
``safe_details`` keeps only allow-listed field names with scalar values, so a careless caller
cannot leak personal data (phone numbers, addresses, names, free-text reasons, Telegram
``initData``, cookies, tokens) into a table that is kept forever and cannot be edited.
"""

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, time
from enum import Enum
from typing import Any, Final

from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.enums import UserRole

MAX_TEXT_LENGTH: Final = 200

# Field names that may appear in ``changes``, per entity type. Anything else is dropped.
ALLOWED_FIELDS: Final[Mapping[str, frozenset[str]]] = {
    "category": frozenset(
        {"slug", "name_uz", "name_ru", "parent_id", "sort_order", "is_active", "image_url"}
    ),
    "product": frozenset(
        {
            "sku",
            "slug",
            "name_uz",
            "name_ru",
            "category_id",
            "unit",
            "price_uzs",
            "old_price_uzs",
            "stock_quantity",
            "is_active",
            "sort_order",
            "image_url",
            "archived",
        }
    ),
    "zone": frozenset(
        {
            "slug",
            "name_uz",
            "name_ru",
            "delivery_fee_uzs",
            "free_delivery_threshold_uzs",
            "min_order_uzs",
            "opens_at",
            "closes_at",
            "sort_order",
            "is_active",
            "districts",
        }
    ),
    "slot": frozenset(
        {"zone_id", "slot_date", "starts_at", "ends_at", "capacity", "cutoff_at", "is_active"}
    ),
    "user": frozenset({"role", "is_blocked"}),
    "order": frozenset({"status"}),
    "catalog": frozenset(),
}

# Keys allowed in ``extra`` (context that is not a field change).
ALLOWED_EXTRA: Final = frozenset(
    {
        "source",
        "order_number",
        "has_reason",
        "rows",
        "creates",
        "updates",
        "unchanged",
        "sku",
        "slug",
        "district_count",
    }
)
# Allow-listed ``extra`` flags whose name contains a denied word ("reason"): only a bool is kept,
# so the flag can say *that* there was a reason without the text ever passing.
_FLAG_EXTRA: Final = frozenset({"has_reason"})

# Defence in depth: even an allow-listed name is refused if it looks personal or secret.
_DENY = re.compile(
    r"phone|address|recipient|comment|init_?data|token|cookie|csrf|password|secret|username|"
    r"first_name|last_name|telegram|reason|description|street|house|apartment|landmark",
    re.IGNORECASE,
)

Scalar = str | int | bool | None


class AuditEntity:
    CATEGORY: Final = "category"
    PRODUCT: Final = "product"
    CATALOG: Final = "catalog"
    ZONE: Final = "zone"
    SLOT: Final = "slot"
    USER: Final = "user"
    ORDER: Final = "order"


@dataclass(frozen=True, slots=True)
class AuditActor:
    user_id: uuid.UUID | None
    role: UserRole


def _scalar(value: object) -> Scalar:  # noqa: PLR0911 - one branch per value kind
    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, Enum):
        return _scalar(value.value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, list | tuple | set | frozenset):
        # Only short collections of identifiers (e.g. district codes) are meaningful here.
        items = sorted(str(item) for item in value)
        return _truncate(",".join(items))
    if isinstance(value, str):
        return _truncate(value)
    return None


def _truncate(value: str) -> str:
    return value if len(value) <= MAX_TEXT_LENGTH else value[: MAX_TEXT_LENGTH - 1] + "…"


def safe_details(
    entity_type: str,
    changes: Mapping[str, tuple[object, object]] | None = None,
    extra: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """``{"changes": {field: {"from": .., "to": ..}}, **extra}`` with everything unsafe dropped."""
    allowed = ALLOWED_FIELDS.get(entity_type, frozenset())
    safe_changes: dict[str, dict[str, Scalar]] = {}
    for field, (before, after) in (changes or {}).items():
        if field not in allowed or _DENY.search(field):
            continue
        safe_changes[field] = {"from": _scalar(before), "to": _scalar(after)}
    details: dict[str, Any] = {}
    if safe_changes:
        details["changes"] = safe_changes
    for key, value in (extra or {}).items():
        if key in _FLAG_EXTRA:
            if isinstance(value, bool):
                details[key] = value
        elif key in ALLOWED_EXTRA and not _DENY.search(key):
            details[key] = _scalar(value)
    return details


def diff_fields(
    before: Mapping[str, object], after: Mapping[str, object]
) -> dict[str, tuple[object, object]]:
    """The ``{field: (before, after)}`` pairs whose value changed."""
    return {
        field: (before.get(field), value)
        for field, value in after.items()
        if before.get(field) != value
    }


def record_audit(
    session: AsyncSession,
    actor: AuditActor,
    *,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | str,
    changes: Mapping[str, tuple[object, object]] | None = None,
    extra: Mapping[str, object] | None = None,
) -> None:
    """Add an audit row to ``session`` (flushed and committed with the caller's transaction)."""
    session.add(
        AuditLog(
            actor_user_id=actor.user_id,
            actor_role=actor.role,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            details=safe_details(entity_type, changes, extra),
            # Wall-clock time so several rows in one transaction keep their order.
            created_at=func.clock_timestamp(),
        )
    )
