"""Synthetic catalog data for local development and tests: ``python -m app.dev.seed``.

Refuses to run unless ``APP_ENV`` is ``development`` or ``test``. Everything here is made up:
generic ``Demo``/``Демо`` names, ``DEMO-`` SKUs, round prices and no image URLs (the web app shows a
placeholder). It is safe to run repeatedly: rows are upserted by slug and an unchanged row is not
touched, so a second run changes nothing.

The data deliberately includes the edge cases the catalog and cart must handle: products with an
old price, untracked stock, an out-of-stock product, an inactive product, an inactive category,
and an active category nested under an inactive one (which must stay hidden).

Delivery zones (``Demo``/``Демо`` names, round fees, Asia/Tashkent hours) cover Tashkent's
districts: a zone with a free-delivery threshold, one with a higher minimum order, one where
delivery is never free, and an inactive zone whose districts are therefore not served.
"""

import asyncio
import logging
import sys
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import time

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.session import create_engine, create_session_factory
from app.domain.delivery import DistrictCode
from app.models.catalog import Category, Product
from app.models.delivery import DeliveryZone, DeliveryZoneDistrict
from app.models.enums import Unit

logger = logging.getLogger("app.dev.seed")

ALLOWED_ENVIRONMENTS = ("development", "test")


class SeedRefusedError(Exception):
    """Raised when the seed is started outside a development/test environment."""


def ensure_safe_environment(app_env: str) -> None:
    if app_env not in ALLOWED_ENVIRONMENTS:
        raise SeedRefusedError(
            f"refusing to seed demo data when APP_ENV={app_env!r} "
            f"(allowed: {', '.join(ALLOWED_ENVIRONMENTS)})"
        )


@dataclass(frozen=True, slots=True)
class SeedCategory:
    slug: str
    name_uz: str
    name_ru: str
    sort_order: int
    parent_slug: str | None = None
    is_active: bool = True


@dataclass(frozen=True, slots=True)
class SeedProduct:
    sku: str
    slug: str
    category_slug: str
    name_uz: str
    name_ru: str
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None = None
    # None = stock is not tracked.
    stock_quantity: int | None = None
    brand: str | None = None
    is_active: bool = True


# Parents come before their children.
DEMO_CATEGORIES: tuple[SeedCategory, ...] = (
    SeedCategory(
        "demo-mevalar-sabzavotlar", "Demo mevalar va sabzavotlar", "Демо овощи и фрукты", 10
    ),
    SeedCategory(
        "demo-mevalar", "Demo mevalar", "Демо фрукты", 10, parent_slug="demo-mevalar-sabzavotlar"
    ),
    SeedCategory(
        "demo-sabzavotlar",
        "Demo sabzavotlar",
        "Демо овощи",
        20,
        parent_slug="demo-mevalar-sabzavotlar",
    ),
    SeedCategory("demo-ichimliklar", "Demo ichimliklar", "Демо напитки", 20),
    SeedCategory(
        "demo-sharbatlar", "Demo sharbatlar", "Демо соки", 10, parent_slug="demo-ichimliklar"
    ),
    SeedCategory("demo-sut", "Demo sut mahsulotlari", "Демо молочные продукты", 30),
    # An inactive category hides its whole subtree, including the active child below.
    SeedCategory(
        "demo-arxiv", "Demo arxiv (nofaol)", "Демо архив (неактивно)", 99, is_active=False
    ),
    SeedCategory(
        "demo-arxiv-ichki", "Demo arxiv ichki", "Демо архив вложенный", 10, parent_slug="demo-arxiv"
    ),
)

DEMO_PRODUCTS: tuple[SeedProduct, ...] = (
    SeedProduct(
        "DEMO-0001",
        "demo-olma",
        "demo-mevalar",
        "Demo olma",
        "Демо яблоко",
        Unit.KG,
        15_000,
        old_price_uzs=18_000,
        stock_quantity=120,
        brand="Demo",
    ),
    SeedProduct(
        "DEMO-0002", "demo-banan", "demo-mevalar", "Demo banan", "Демо банан", Unit.KG, 22_000
    ),
    SeedProduct(
        "DEMO-0003",
        "demo-uzum",
        "demo-mevalar",
        "Demo uzum",
        "Демо виноград",
        Unit.KG,
        35_000,
        stock_quantity=40,
    ),
    SeedProduct(
        "DEMO-0004",
        "demo-pomidor",
        "demo-sabzavotlar",
        "Demo pomidor",
        "Демо помидор",
        Unit.KG,
        12_000,
        old_price_uzs=14_000,
        stock_quantity=80,
    ),
    SeedProduct(
        "DEMO-0005",
        "demo-bodring",
        "demo-sabzavotlar",
        "Demo bodring",
        "Демо огурец",
        Unit.KG,
        10_000,
    ),
    SeedProduct(
        "DEMO-0006",
        "demo-sabzi",
        "demo-sabzavotlar",
        "Demo sabzi",
        "Демо морковь",
        Unit.KG,
        8_000,
        stock_quantity=200,
    ),
    SeedProduct(
        "DEMO-0007",
        "demo-olma-sharbati",
        "demo-sharbatlar",
        "Demo olma sharbati",
        "Демо яблочный сок",
        Unit.L,
        18_000,
        stock_quantity=60,
        brand="Demo",
    ),
    # Out of stock (tracked, zero left).
    SeedProduct(
        "DEMO-0008",
        "demo-shaftoli-sharbati",
        "demo-sharbatlar",
        "Demo shaftoli sharbati",
        "Демо персиковый сок",
        Unit.L,
        20_000,
        old_price_uzs=25_000,
        stock_quantity=0,
        brand="Demo",
    ),
    SeedProduct(
        "DEMO-0009",
        "demo-ichimlik-suvi",
        "demo-ichimliklar",
        "Demo ichimlik suvi",
        "Демо питьевая вода",
        Unit.L,
        5_000,
    ),
    SeedProduct(
        "DEMO-0010",
        "demo-sut",
        "demo-sut",
        "Demo sut",
        "Демо молоко",
        Unit.L,
        14_000,
        stock_quantity=30,
    ),
    SeedProduct(
        "DEMO-0011",
        "demo-qatiq",
        "demo-sut",
        "Demo qatiq",
        "Демо катык",
        Unit.PIECE,
        9_000,
        stock_quantity=25,
    ),
    SeedProduct(
        "DEMO-0012",
        "demo-pishloq",
        "demo-sut",
        "Demo pishloq",
        "Демо сыр",
        Unit.PIECE,
        45_000,
        old_price_uzs=50_000,
        stock_quantity=15,
    ),
    # Inactive product in an active category.
    SeedProduct(
        "DEMO-0013",
        "demo-eski-mahsulot",
        "demo-mevalar",
        "Demo eski mahsulot",
        "Демо старый товар",
        Unit.PIECE,
        7_000,
        stock_quantity=5,
        is_active=False,
    ),
    # Active product whose category chain contains an inactive category.
    SeedProduct(
        "DEMO-0014",
        "demo-arxiv-mahsulot",
        "demo-arxiv-ichki",
        "Demo arxiv mahsulot",
        "Демо архивный товар",
        Unit.PIECE,
        6_000,
        stock_quantity=9,
    ),
)


@dataclass(frozen=True, slots=True)
class SeedZone:
    slug: str
    name_uz: str
    name_ru: str
    delivery_fee_uzs: int
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    opens_at: time
    closes_at: time
    sort_order: int
    districts: tuple[DistrictCode, ...]
    is_active: bool = True


# Every district appears in exactly one zone (``delivery_zone_districts`` enforces it).
DEMO_ZONES: tuple[SeedZone, ...] = (
    SeedZone(
        "demo-markaziy",
        "Demo markaziy zona",
        "Демо центральная зона",
        delivery_fee_uzs=15_000,
        free_delivery_threshold_uzs=300_000,
        min_order_uzs=50_000,
        opens_at=time(9, 0),
        closes_at=time(21, 0),
        sort_order=10,
        districts=("mirobod", "yakkasaroy", "shayxontohur", "yunusobod", "mirzo_ulugbek"),
    ),
    SeedZone(
        "demo-chekka",
        "Demo chekka zona",
        "Демо окраинная зона",
        delivery_fee_uzs=25_000,
        free_delivery_threshold_uzs=500_000,
        min_order_uzs=100_000,
        opens_at=time(9, 0),
        closes_at=time(20, 0),
        sort_order=20,
        districts=("chilonzor", "olmazor", "uchtepa", "yashnobod"),
    ),
    SeedZone(
        "demo-janubiy",
        "Demo janubiy zona",
        "Демо южная зона",
        delivery_fee_uzs=30_000,
        free_delivery_threshold_uzs=None,
        min_order_uzs=150_000,
        opens_at=time(10, 0),
        closes_at=time(19, 0),
        sort_order=30,
        districts=("sergeli",),
    ),
    SeedZone(
        "demo-yopiq",
        "Demo yopiq zona",
        "Демо закрытая зона",
        delivery_fee_uzs=40_000,
        free_delivery_threshold_uzs=None,
        min_order_uzs=200_000,
        opens_at=time(10, 0),
        closes_at=time(18, 0),
        sort_order=40,
        districts=("bektemir", "yangihayot"),
        is_active=False,
    ),
)

ZONE_COLUMNS = (
    "name_uz",
    "name_ru",
    "delivery_fee_uzs",
    "free_delivery_threshold_uzs",
    "min_order_uzs",
    "opens_at",
    "closes_at",
    "sort_order",
    "is_active",
)

CATEGORY_COLUMNS = ("parent_id", "name_uz", "name_ru", "image_url", "sort_order", "is_active")
PRODUCT_COLUMNS = (
    "category_id",
    "sku",
    "name_uz",
    "name_ru",
    "description_uz",
    "description_ru",
    "brand",
    "unit",
    "price_uzs",
    "old_price_uzs",
    "stock_quantity",
    "image_url",
    "is_active",
)


@dataclass(frozen=True, slots=True)
class SeedResult:
    categories_written: int
    products_written: int
    zones_written: int = 0


def _differs(
    model: type[Category] | type[Product] | type[DeliveryZone] | type[DeliveryZoneDistrict],
    excluded: object,
    columns: Iterable[str],
) -> ColumnElement[bool]:
    """True when any listed column of the stored row differs from the incoming one."""
    return or_(
        *(getattr(model, column).is_distinct_from(getattr(excluded, column)) for column in columns)
    )


async def _seed_categories(session: AsyncSession) -> tuple[dict[str, uuid.UUID], int]:
    ids: dict[str, uuid.UUID] = {}
    written = 0
    for category in DEMO_CATEGORIES:
        values = {
            "slug": category.slug,
            "parent_id": ids[category.parent_slug] if category.parent_slug else None,
            "name_uz": category.name_uz,
            "name_ru": category.name_ru,
            "image_url": None,
            "sort_order": category.sort_order,
            "is_active": category.is_active,
        }
        statement = insert(Category).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[Category.slug],
            set_={column: getattr(statement.excluded, column) for column in CATEGORY_COLUMNS},
            where=_differs(Category, statement.excluded, CATEGORY_COLUMNS),
        )
        result = await session.execute(statement)
        written += result.rowcount  # type: ignore[attr-defined]
        ids[category.slug] = (
            await session.execute(select(Category.id).where(Category.slug == category.slug))
        ).scalar_one()
    return ids, written


async def _seed_products(session: AsyncSession, category_ids: dict[str, uuid.UUID]) -> int:
    written = 0
    for product in DEMO_PRODUCTS:
        values = {
            "slug": product.slug,
            "category_id": category_ids[product.category_slug],
            "sku": product.sku,
            "name_uz": product.name_uz,
            "name_ru": product.name_ru,
            "description_uz": f"{product.name_uz}. Faqat test uchun namunaviy mahsulot.",
            "description_ru": f"{product.name_ru}. Демо-товар только для тестирования.",
            "brand": product.brand,
            "unit": product.unit,
            "price_uzs": product.price_uzs,
            "old_price_uzs": product.old_price_uzs,
            "stock_quantity": product.stock_quantity,
            "image_url": None,
            "is_active": product.is_active,
        }
        statement = insert(Product).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[Product.slug],
            set_={column: getattr(statement.excluded, column) for column in PRODUCT_COLUMNS},
            where=_differs(Product, statement.excluded, PRODUCT_COLUMNS),
        )
        written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
    return written


async def _seed_zones(session: AsyncSession) -> int:
    """Upsert zones by slug and districts by district; returns zone rows written."""
    written = 0
    for zone in DEMO_ZONES:
        values = {column: getattr(zone, column) for column in ZONE_COLUMNS}
        statement = insert(DeliveryZone).values(slug=zone.slug, **values)
        statement = statement.on_conflict_do_update(
            index_elements=[DeliveryZone.slug],
            set_={column: getattr(statement.excluded, column) for column in ZONE_COLUMNS},
            where=_differs(DeliveryZone, statement.excluded, ZONE_COLUMNS),
        )
        written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
        zone_id = (
            await session.execute(select(DeliveryZone.id).where(DeliveryZone.slug == zone.slug))
        ).scalar_one()
        for district in zone.districts:
            link = insert(DeliveryZoneDistrict).values(district=district, zone_id=zone_id)
            await session.execute(
                link.on_conflict_do_update(
                    index_elements=[DeliveryZoneDistrict.district],
                    set_={"zone_id": link.excluded.zone_id},
                    where=_differs(DeliveryZoneDistrict, link.excluded, ("zone_id",)),
                )
            )
    return written


async def seed(session_factory: async_sessionmaker[AsyncSession]) -> SeedResult:
    """Upsert the demo catalog and delivery zones in one transaction."""
    async with session_factory() as session:
        category_ids, categories_written = await _seed_categories(session)
        products_written = await _seed_products(session, category_ids)
        zones_written = await _seed_zones(session)
        await session.commit()
    return SeedResult(
        categories_written=categories_written,
        products_written=products_written,
        zones_written=zones_written,
    )


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    settings = get_settings()
    try:
        ensure_safe_environment(settings.app_env)
    except SeedRefusedError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    engine = create_engine(settings)
    try:
        result = await seed(create_session_factory(engine))
    finally:
        await engine.dispose()
    logger.info(
        "demo data seeded: %d categories, %d products and %d delivery zones written "
        "(%d/%d/%d unchanged)",
        result.categories_written,
        result.products_written,
        result.zones_written,
        len(DEMO_CATEGORIES) - result.categories_written,
        len(DEMO_PRODUCTS) - result.products_written,
        len(DEMO_ZONES) - result.zones_written,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
