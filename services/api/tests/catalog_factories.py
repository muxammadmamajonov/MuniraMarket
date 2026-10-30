"""Record builders shared by the catalog and cart route tests (no database involved)."""

import uuid
from typing import Any

from app.models.enums import Language, Unit, UserRole
from app.repositories.cart import CartLineRecord
from app.repositories.catalog import (
    CategoryNodeRecord,
    CategoryRefRecord,
    ProductDetailRecord,
    ProductSummaryRecord,
)
from app.repositories.users import UserRecord


def make_user(**overrides: Any) -> UserRecord:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "telegram_user_id": 555_000_111,
        "first_name": "Test",
        "last_name": None,
        "username": None,
        "language": Language.UZ,
        "role": UserRole.CUSTOMER,
        "is_blocked": False,
    }
    values.update(overrides)
    return UserRecord(**values)


def make_product(**overrides: Any) -> ProductSummaryRecord:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "slug": "demo-product",
        "sku": "DEMO-0001",
        "name_uz": "Demo mahsulot",
        "name_ru": "Демо товар",
        "unit": Unit.KG,
        "price_uzs": 12_000,
        "old_price_uzs": None,
        "stock_quantity": None,
        "image_url": None,
        "category_id": uuid.uuid4(),
    }
    values.update(overrides)
    return ProductSummaryRecord(**values)


def make_line(
    product: ProductSummaryRecord | None = None,
    *,
    quantity: int = 1,
    is_available: bool = True,
) -> CartLineRecord:
    return CartLineRecord(
        product=product or make_product(), quantity=quantity, is_available=is_available
    )


def make_detail(summary: ProductSummaryRecord | None = None) -> ProductDetailRecord:
    summary = summary or make_product()
    return ProductDetailRecord(
        summary=summary,
        description_uz="Demo tavsif",
        description_ru="Демо описание",
        brand="Demo",
        category=CategoryRefRecord(
            id=summary.category_id, slug="demo-category", name_uz="Demo", name_ru="Демо"
        ),
    )


def make_category(
    slug: str, *, children: tuple[CategoryNodeRecord, ...] = (), sort_order: int = 0
) -> CategoryNodeRecord:
    return CategoryNodeRecord(
        id=uuid.uuid4(),
        slug=slug,
        name_uz=f"Demo {slug}",
        name_ru=f"Демо {slug}",
        image_url=None,
        sort_order=sort_order,
        children=children,
    )
