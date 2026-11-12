"""Synthetic catalog data for local development and tests: ``python -m app.dev.seed``.

Refuses to run unless ``APP_ENV`` is ``development`` or ``test``. The data is the one canonical
demo dataset in ``app.ops.demo_dataset`` (also used, minus its ``dev_only`` rows, by the
operator-run production demo import ``app.ops.demo_catalog``): a realistic mock Tashkent grocery
catalog (9 top-level categories, about 45 products in uz and ru, plausible so'm prices) so the demo
looks like a real store, yet everything is made up: the synthetic markers are the ``DEMO-NNNN``
SKUs, the ``demo-`` slugs and invented brand names (``SYNTHETIC_BRANDS``, never a real trademark).
Products and categories get the demo stock photos (``app.ops.demo_images``): the bare storefront
path (``/products/banan.webp``), or an absolute URL when ``DEMO_IMAGE_BASE_URL`` is set. It is safe
to run repeatedly: rows are upserted by slug and an unchanged row is not touched, so a second run
changes nothing. A demo product an admin has archived is left alone (not reactivated, not updated).

The data deliberately includes the edge cases the catalog and cart must handle: products with an
old price, untracked stock, low stock, out-of-stock products, a very long product name, an inactive
product, an inactive category, and an active category nested under an inactive one (which must
stay hidden).
"""

import asyncio
import logging
import os
import sys
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.session import create_engine, create_session_factory
from app.models.catalog import Category, Product
from app.ops.demo_dataset import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    SYNTHETIC_BRANDS,
    SeedCategory,
    SeedProduct,
)
from app.ops.demo_images import (
    IMAGE_BASE_URL_ENV,
    category_image_url,
    product_image_url,
    validate_image_base_url,
)

__all__ = [
    "DEMO_CATEGORIES",
    "DEMO_PRODUCTS",
    "SYNTHETIC_BRANDS",
    "SeedCategory",
    "SeedProduct",
    "SeedRefusedError",
    "SeedResult",
    "ensure_safe_environment",
    "seed",
]

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


def _differs(
    model: type[Category] | type[Product],
    excluded: object,
    columns: Iterable[str],
) -> ColumnElement[bool]:
    """True when any listed column of the stored row differs from the incoming one."""
    return or_(
        *(getattr(model, column).is_distinct_from(getattr(excluded, column)) for column in columns)
    )


async def _seed_categories(
    session: AsyncSession, image_base_url: str | None
) -> tuple[dict[str, uuid.UUID], int]:
    ids: dict[str, uuid.UUID] = {}
    written = 0
    for category in DEMO_CATEGORIES:
        values = {
            "slug": category.slug,
            "parent_id": ids[category.parent_slug] if category.parent_slug else None,
            "name_uz": category.name_uz,
            "name_ru": category.name_ru,
            "image_url": category_image_url(category.slug, image_base_url),
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


async def _seed_products(
    session: AsyncSession, category_ids: dict[str, uuid.UUID], image_base_url: str | None
) -> int:
    written = 0
    for product in DEMO_PRODUCTS:
        values = {
            "slug": product.slug,
            "category_id": category_ids[product.category_slug],
            "sku": product.sku,
            "name_uz": product.name_uz,
            "name_ru": product.name_ru,
            "description_uz": product.description_uz,
            "description_ru": product.description_ru,
            "brand": product.brand,
            "unit": product.unit,
            "price_uzs": product.price_uzs,
            "old_price_uzs": product.old_price_uzs,
            "stock_quantity": product.stock_quantity,
            "image_url": product_image_url(product.slug, image_base_url),
            "is_active": product.is_active,
        }
        statement = insert(Product).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[Product.slug],
            set_={column: getattr(statement.excluded, column) for column in PRODUCT_COLUMNS},
            # An admin archived it: leave it archived (and inactive, as the CHECK requires).
            where=Product.archived_at.is_(None)
            & _differs(Product, statement.excluded, PRODUCT_COLUMNS),
        )
        written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
    return written


async def seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    image_base_url: str | None = None,
) -> SeedResult:
    """Upsert the demo catalog in one transaction.

    ``image_base_url`` (a validated origin) makes the photo URLs absolute; ``None`` keeps paths.
    """
    async with session_factory() as session:
        category_ids, categories_written = await _seed_categories(session, image_base_url)
        products_written = await _seed_products(session, category_ids, image_base_url)
        await session.commit()
    return SeedResult(categories_written=categories_written, products_written=products_written)


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    settings = get_settings()
    try:
        ensure_safe_environment(settings.app_env)
    except SeedRefusedError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    raw_base = os.environ.get(IMAGE_BASE_URL_ENV, "").strip()
    image_base_url = validate_image_base_url(raw_base) if raw_base else None
    engine = create_engine(settings)
    try:
        result = await seed(create_session_factory(engine), image_base_url=image_base_url)
    finally:
        await engine.dispose()
    logger.info(
        "demo data seeded: %d categories and %d products written (%d/%d unchanged)",
        result.categories_written,
        result.products_written,
        len(DEMO_CATEGORIES) - result.categories_written,
        len(DEMO_PRODUCTS) - result.products_written,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
