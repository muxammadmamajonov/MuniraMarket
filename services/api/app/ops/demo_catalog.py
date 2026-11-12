"""Operator-run demo catalog for a fresh production (or staging) database.

    DEMO_IMPORT_DATABASE_URL=... uv run python -m app.ops.demo_catalog status
    DEMO_IMPORT_DATABASE_URL=... uv run python -m app.ops.demo_catalog import \
        --confirm "IMPORT DEMO CATALOG"
    DEMO_IMPORT_DATABASE_URL=... uv run python -m app.ops.demo_catalog images \
        --confirm "SET DEMO IMAGES"
    DEMO_IMPORT_DATABASE_URL=... uv run python -m app.ops.demo_catalog remove \
        --confirm "REMOVE DEMO CATALOG"

Nothing runs this automatically: it is not wired into migrations, app start-up or any deploy
step. ``import``, ``remove`` and ``images`` are dry runs (one transaction that is rolled back)
unless ``--confirm`` carries the exact phrase; a wrong phrase is refused before any connection is
made.

The data is the canonical synthetic dataset in ``app.ops.demo_dataset`` without its ``dev_only``
edge-case rows. Demo rows are recognised by their markers only (no extra column, no migration):
category and zone slugs start with ``demo-``; a product is demo when its slug starts with
``demo-`` AND its SKU with ``DEMO-``. Everything else is real data and is never changed.

``import`` (one transaction, serialised by an advisory lock):

- refuses when the catalog holds any non-demo category or product, so it can only ever fill an
  empty (or demo-only) catalog;
- inserts the missing demo categories (with subcategories), products and, when the database has
  no non-demo delivery zone, the demo delivery zones (``Demo``/``Демо`` names) with their
  districts. Rows that already exist are left exactly as they are (an admin's edits survive), so
  a second run writes nothing. No delivery slots (they are dated and would go stale): the demo
  zones take orders without a slot;
- sets the demo photos (``app.ops.demo_images``): storefront paths such as
  ``/products/banan.webp``, or absolute URLs on the origin given by ``--image-base-url`` (or
  ``DEMO_IMAGE_BASE_URL``).

``images`` (one transaction) backfills those photo URLs for a catalog imported before the photos
existed: it sets ``image_url`` only on demo categories and products whose ``image_url`` is
empty, so an image an admin chose is never replaced and a second run writes nothing.

``remove`` (one transaction) touches demo rows only:

- demo products that order lines reference are archived (inactive, ``archived_at`` set) instead
  of deleted, so order history keeps its links; the others are deleted (cart lines go with them);
- demo categories that end up empty are deleted; one still holding an archived demo product is
  deactivated; one that holds real (non-demo) products or subcategories is left untouched,
  together with its demo ancestors;
- demo delivery zones release their districts; a zone or slot that orders reference is
  deactivated and kept, everything else is deleted.

Each command adds one ``audit_log`` row when they change something. The database URL comes only
from ``DEMO_IMPORT_DATABASE_URL`` and no part of it is ever printed or logged: unexpected errors are
reported by exception type only, because driver messages can contain the host or user name.
"""

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TextIO

from sqlalchemy import (
    ColumnElement,
    SQLColumnExpression,
    and_,
    exists,
    func,
    not_,
    or_,
    select,
    text,
    update,
)
from sqlalchemy import delete as sql_delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import aliased
from sqlalchemy.pool import NullPool

from app.audit import AuditActor, AuditEntity, record_audit
from app.core.config import DEPLOYED_SSL_MODE
from app.models.catalog import Category, Product
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict
from app.models.enums import UserRole
from app.models.order import Order, OrderItem
from app.ops.demo_dataset import (
    SYNTHETIC_BRANDS,
    production_categories,
    production_products,
    production_zones,
)
from app.ops.demo_images import (
    DEMO_CATEGORY_IMAGES,
    DEMO_PRODUCT_IMAGES,
    IMAGE_BASE_URL_ENV,
    InvalidImageBaseUrlError,
    category_image_url,
    demo_image_url,
    product_image_url,
    validate_image_base_url,
)

DATABASE_URL_ENV = "DEMO_IMPORT_DATABASE_URL"
IMPORT_PHRASE = "IMPORT DEMO CATALOG"
REMOVE_PHRASE = "REMOVE DEMO CATALOG"
IMAGES_PHRASE = "SET DEMO IMAGES"
PHRASES = {"import": IMPORT_PHRASE, "remove": REMOVE_PHRASE, "images": IMAGES_PHRASE}
DEMO_SLUG_PREFIX = "demo-"
DEMO_SKU_PREFIX = "DEMO-"
APPLICATION_NAME = "muniramarket-demo-catalog"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# pg_advisory_xact_lock key: two concurrent runs serialise instead of interleaving.
LOCK_KEY = 0x4D4D_DE30_CA7A
# Audit rows of this tool: an operator command, not a signed-in user.
AUDIT_ACTOR = AuditActor(user_id=None, role=UserRole.ADMIN)
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_REFUSED = 3


class DemoCatalogError(Exception):
    """A refusal with a message that is safe to print (it never contains the database URL)."""


# --- demo markers ---------------------------------------------------------------------------------


def _demo_slug(column: SQLColumnExpression[str]) -> ColumnElement[bool]:
    return column.startswith(DEMO_SLUG_PREFIX, autoescape=True)


def demo_category() -> ColumnElement[bool]:
    return _demo_slug(Category.slug)


def demo_product() -> ColumnElement[bool]:
    return and_(_demo_slug(Product.slug), Product.sku.startswith(DEMO_SKU_PREFIX, autoescape=True))


def demo_zone() -> ColumnElement[bool]:
    return _demo_slug(DeliveryZone.slug)


# --- reports --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CatalogStatus:
    demo_categories: int
    demo_products: int
    demo_products_archived: int
    demo_products_in_orders: int
    demo_zones: int
    other_categories: int
    other_products: int
    other_zones: int

    @property
    def import_allowed(self) -> bool:
        return self.other_categories == 0 and self.other_products == 0


@dataclass(frozen=True, slots=True)
class ImportReport:
    applied: bool
    categories_created: int
    products_created: int
    zones_created: int
    districts_assigned: int
    # True when real delivery zones exist, so the demo zones were not added.
    zones_skipped: bool
    # The origin the photo URLs point at; None = storefront paths (``/products/banan.webp``).
    image_base_url: str | None = None

    @property
    def changed(self) -> int:
        return (
            self.categories_created
            + self.products_created
            + self.zones_created
            + self.districts_assigned
        )


@dataclass(frozen=True, slots=True)
class RemoveReport:
    applied: bool
    products_deleted: int
    products_archived: int
    categories_deleted: int
    categories_deactivated: int
    # Demo categories that still hold real products/subcategories: left untouched.
    categories_kept: int
    zones_deleted: int
    zones_deactivated: int
    slots_deleted: int
    slots_deactivated: int
    districts_released: int

    @property
    def changed(self) -> int:
        return (
            self.products_deleted
            + self.products_archived
            + self.categories_deleted
            + self.categories_deactivated
            + self.zones_deleted
            + self.zones_deactivated
            + self.slots_deleted
            + self.slots_deactivated
            + self.districts_released
        )


@dataclass(frozen=True, slots=True)
class ImagesReport:
    applied: bool
    image_base_url: str | None
    categories_updated: int
    products_updated: int
    # Demo rows that already have an image URL: left exactly as they are.
    categories_kept: int
    products_kept: int

    @property
    def changed(self) -> int:
        return self.categories_updated + self.products_updated


# --- shared transaction helpers -------------------------------------------------------------------


async def _begin(session: AsyncSession) -> None:
    """Guards for the (only) transaction: bounded waits and one run at a time."""
    await session.execute(text("SET LOCAL lock_timeout = '10s'"))
    await session.execute(text("SET LOCAL statement_timeout = '60s'"))
    await session.execute(select(func.pg_advisory_xact_lock(LOCK_KEY)))


async def _count(session: AsyncSession, model: type[object], *where: ColumnElement[bool]) -> int:
    statement = select(func.count()).select_from(model).where(*where)
    return int((await session.execute(statement)).scalar_one())


def _rowcount(result: object) -> int:
    return int(result.rowcount)  # type: ignore[attr-defined]


async def _status(session: AsyncSession) -> CatalogStatus:
    referenced = exists(select(OrderItem.id).where(OrderItem.product_id == Product.id))
    return CatalogStatus(
        demo_categories=await _count(session, Category, demo_category()),
        demo_products=await _count(session, Product, demo_product()),
        demo_products_archived=await _count(
            session, Product, demo_product(), Product.archived_at.is_not(None)
        ),
        demo_products_in_orders=await _count(session, Product, demo_product(), referenced),
        demo_zones=await _count(session, DeliveryZone, demo_zone()),
        other_categories=await _count(session, Category, not_(demo_category())),
        other_products=await _count(session, Product, not_(demo_product())),
        other_zones=await _count(session, DeliveryZone, not_(demo_zone())),
    )


# --- status ---------------------------------------------------------------------------------------


async def demo_catalog_status(session_factory: async_sessionmaker[AsyncSession]) -> CatalogStatus:
    """Read-only counts of demo and real rows."""
    async with session_factory() as session:
        await session.execute(text("SET TRANSACTION READ ONLY"))
        status = await _status(session)
        await session.rollback()
    return status


# --- import ---------------------------------------------------------------------------------------


async def _insert_categories(
    session: AsyncSession, image_base_url: str | None
) -> tuple[dict[str, object], int]:
    ids: dict[str, object] = {}
    created = 0
    for category in production_categories():
        statement = (
            insert(Category)
            .values(
                slug=category.slug,
                parent_id=ids[category.parent_slug] if category.parent_slug else None,
                name_uz=category.name_uz,
                name_ru=category.name_ru,
                image_url=category_image_url(category.slug, image_base_url),
                sort_order=category.sort_order,
                is_active=category.is_active,
            )
            .on_conflict_do_nothing()
            .returning(Category.id)
        )
        new_id = (await session.execute(statement)).scalar_one_or_none()
        if new_id is None:  # already there: keep it exactly as it is
            new_id = (
                await session.execute(select(Category.id).where(Category.slug == category.slug))
            ).scalar_one()
        else:
            created += 1
        ids[category.slug] = new_id
    return ids, created


async def _insert_products(
    session: AsyncSession, category_ids: Mapping[str, object], image_base_url: str | None
) -> int:
    created = 0
    for product in production_products():
        statement = (
            insert(Product)
            .values(
                slug=product.slug,
                sku=product.sku,
                category_id=category_ids[product.category_slug],
                name_uz=product.name_uz,
                name_ru=product.name_ru,
                description_uz=product.description_uz,
                description_ru=product.description_ru,
                brand=product.brand,
                unit=product.unit,
                price_uzs=product.price_uzs,
                old_price_uzs=product.old_price_uzs,
                stock_quantity=product.stock_quantity,
                image_url=product_image_url(product.slug, image_base_url),
                is_active=product.is_active,
            )
            # A conflict on the slug or the SKU means the demo product is already there.
            .on_conflict_do_nothing()
            .returning(Product.id)
        )
        if (await session.execute(statement)).scalar_one_or_none() is not None:
            created += 1
    return created


async def _insert_zones(session: AsyncSession) -> tuple[int, int]:
    zones_created = districts_assigned = 0
    for zone in production_zones():
        statement = (
            insert(DeliveryZone)
            .values(
                slug=zone.slug,
                name_uz=zone.name_uz,
                name_ru=zone.name_ru,
                delivery_fee_uzs=zone.delivery_fee_uzs,
                free_delivery_threshold_uzs=zone.free_delivery_threshold_uzs,
                min_order_uzs=zone.min_order_uzs,
                opens_at=zone.opens_at,
                closes_at=zone.closes_at,
                sort_order=zone.sort_order,
                is_active=zone.is_active,
            )
            .on_conflict_do_nothing()
            .returning(DeliveryZone.id)
        )
        zone_id = (await session.execute(statement)).scalar_one_or_none()
        if zone_id is None:
            zone_id = (
                await session.execute(select(DeliveryZone.id).where(DeliveryZone.slug == zone.slug))
            ).scalar_one()
        else:
            zones_created += 1
        for district in zone.districts:
            # A district already mapped (to a demo zone) keeps its mapping.
            link = (
                insert(DeliveryZoneDistrict)
                .values(district=district, zone_id=zone_id)
                .on_conflict_do_nothing()
                .returning(DeliveryZoneDistrict.district)
            )
            if (await session.execute(link)).scalar_one_or_none() is not None:
                districts_assigned += 1
    return zones_created, districts_assigned


async def import_demo_catalog(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    apply: bool,
    image_base_url: str | None = None,
) -> ImportReport:
    """Insert the missing demo rows in one transaction; rolled back unless ``apply``.

    ``image_base_url`` (from ``validate_image_base_url``) makes the demo photo URLs absolute;
    ``None`` stores the storefront paths.

    Raises ``DemoCatalogError`` (nothing written) when the catalog holds non-demo rows.
    """
    async with session_factory() as session:
        await _begin(session)
        status = await _status(session)
        if not status.import_allowed:
            await session.rollback()
            raise DemoCatalogError(
                "refusing to import: the catalog already contains real data "
                f"({status.other_categories} non-demo categories, "
                f"{status.other_products} non-demo products). The demo catalog is only for an "
                "empty catalog; nothing was changed."
            )
        category_ids, categories_created = await _insert_categories(session, image_base_url)
        products_created = await _insert_products(session, category_ids, image_base_url)
        zones_skipped = status.other_zones > 0
        zones_created = districts_assigned = 0
        if not zones_skipped:
            zones_created, districts_assigned = await _insert_zones(session)
        report = ImportReport(
            applied=apply,
            categories_created=categories_created,
            products_created=products_created,
            zones_created=zones_created,
            districts_assigned=districts_assigned,
            zones_skipped=zones_skipped,
            image_base_url=image_base_url,
        )
        if apply and report.changed:
            record_audit(
                session,
                AUDIT_ACTOR,
                action="catalog.demo_import",
                entity_type=AuditEntity.CATALOG,
                entity_id="demo",
                extra={
                    "source": "demo",
                    "creates": categories_created + products_created + zones_created,
                },
            )
        if apply:
            await session.commit()
        else:
            await session.rollback()
    return report


# --- remove ---------------------------------------------------------------------------------------


async def _remove_products(session: AsyncSession) -> tuple[int, int]:
    in_orders = exists(select(OrderItem.id).where(OrderItem.product_id == Product.id))
    archived = await session.execute(
        update(Product)
        .where(
            demo_product(),
            in_orders,
            (Product.is_active.is_(True)) | Product.archived_at.is_(None),
        )
        .values(is_active=False, archived_at=func.coalesce(Product.archived_at, func.now()))
        .execution_options(synchronize_session=False)
    )
    deleted = await session.execute(
        sql_delete(Product)
        .where(demo_product(), not_(in_orders))
        .execution_options(synchronize_session=False)
    )
    return _rowcount(deleted), _rowcount(archived)


async def _remove_categories(session: AsyncSession) -> tuple[int, int, int]:
    child = aliased(Category)
    has_product = exists(select(Product.id).where(Product.category_id == Category.id))
    has_child = exists(select(child.id).where(child.parent_id == Category.id))
    deleted = 0
    while True:  # leaves first, until nothing more can go
        result = await session.execute(
            sql_delete(Category)
            .where(demo_category(), not_(has_product), not_(has_child))
            .execution_options(synchronize_session=False)
        )
        if _rowcount(result) == 0:
            break
        deleted += _rowcount(result)

    other_product = (
        select(Product.id).where(Product.category_id == Category.id, not_(demo_product())).exists()
    )
    other_child = (
        select(child.id)
        .where(child.parent_id == Category.id, not_(_demo_slug(child.slug)))
        .exists()
    )
    rows = (
        await session.execute(
            select(Category.id, Category.parent_id, other_product | other_child).where(
                demo_category()
            )
        )
    ).all()
    parents = {row[0]: row[1] for row in rows}
    protected: set[object] = set()
    for category_id, _parent, holds_real_rows in rows:
        node = category_id if holds_real_rows else None
        while node is not None and node in parents and node not in protected:
            protected.add(node)  # it and its demo ancestors stay visible and unchanged
            node = parents[node]
    to_deactivate = [row[0] for row in rows if row[0] not in protected]
    deactivated = 0
    if to_deactivate:
        result = await session.execute(
            update(Category)
            .where(Category.id.in_(to_deactivate), Category.is_active.is_(True))
            .values(is_active=False)
            .execution_options(synchronize_session=False)
        )
        deactivated = _rowcount(result)
    return deleted, deactivated, len(protected)


async def _remove_zones(session: AsyncSession) -> tuple[int, int, int, int, int]:
    demo_zone_ids = select(DeliveryZone.id).where(demo_zone()).scalar_subquery()
    slot_in_orders = exists(select(Order.id).where(Order.delivery_slot_id == DeliverySlot.id))
    slots_deleted = await session.execute(
        sql_delete(DeliverySlot)
        .where(DeliverySlot.zone_id.in_(demo_zone_ids), not_(slot_in_orders))
        .execution_options(synchronize_session=False)
    )
    slots_deactivated = await session.execute(
        update(DeliverySlot)
        .where(DeliverySlot.zone_id.in_(demo_zone_ids), DeliverySlot.is_active.is_(True))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )
    # Districts are freed for real zones even where a demo zone has to stay (order history).
    released = await session.execute(
        sql_delete(DeliveryZoneDistrict)
        .where(DeliveryZoneDistrict.zone_id.in_(demo_zone_ids))
        .execution_options(synchronize_session=False)
    )
    zone_in_orders = exists(select(Order.id).where(Order.delivery_zone_id == DeliveryZone.id))
    zone_has_slots = exists(select(DeliverySlot.id).where(DeliverySlot.zone_id == DeliveryZone.id))
    zones_deleted = await session.execute(
        sql_delete(DeliveryZone)
        .where(demo_zone(), not_(zone_in_orders), not_(zone_has_slots))
        .execution_options(synchronize_session=False)
    )
    zones_deactivated = await session.execute(
        update(DeliveryZone)
        .where(demo_zone(), DeliveryZone.is_active.is_(True))
        .values(is_active=False)
        .execution_options(synchronize_session=False)
    )
    return (
        _rowcount(zones_deleted),
        _rowcount(zones_deactivated),
        _rowcount(slots_deleted),
        _rowcount(slots_deactivated),
        _rowcount(released),
    )


async def remove_demo_catalog(
    session_factory: async_sessionmaker[AsyncSession], *, apply: bool
) -> RemoveReport:
    """Delete (or archive/deactivate) the demo rows in one transaction; rolled back unless
    ``apply``. Non-demo rows are never changed."""
    async with session_factory() as session:
        await _begin(session)
        products_deleted, products_archived = await _remove_products(session)
        categories_deleted, categories_deactivated, categories_kept = await _remove_categories(
            session
        )
        (
            zones_deleted,
            zones_deactivated,
            slots_deleted,
            slots_deactivated,
            districts_released,
        ) = await _remove_zones(session)
        report = RemoveReport(
            applied=apply,
            products_deleted=products_deleted,
            products_archived=products_archived,
            categories_deleted=categories_deleted,
            categories_deactivated=categories_deactivated,
            categories_kept=categories_kept,
            zones_deleted=zones_deleted,
            zones_deactivated=zones_deactivated,
            slots_deleted=slots_deleted,
            slots_deactivated=slots_deactivated,
            districts_released=districts_released,
        )
        if apply and report.changed:
            record_audit(
                session,
                AUDIT_ACTOR,
                action="catalog.demo_remove",
                entity_type=AuditEntity.CATALOG,
                entity_id="demo",
                extra={
                    "source": "demo",
                    "rows": products_deleted + categories_deleted + zones_deleted + slots_deleted,
                    "updates": (
                        products_archived
                        + categories_deactivated
                        + zones_deactivated
                        + slots_deactivated
                    ),
                },
            )
        if apply:
            await session.commit()
        else:
            await session.rollback()
    return report


# --- images ---------------------------------------------------------------------------------------


def _no_image(column: SQLColumnExpression[str | None]) -> ColumnElement[bool]:
    return or_(column.is_(None), func.btrim(column) == "")


async def _backfill(
    session: AsyncSession,
    model: type[Category] | type[Product],
    demo: ColumnElement[bool],
    images: Mapping[str, str],
    image_base_url: str | None,
) -> tuple[int, int]:
    kept = await _count(
        session, model, demo, model.slug.in_(list(images)), not_(_no_image(model.image_url))
    )
    updated = 0
    for slug, path in images.items():
        result = await session.execute(
            update(model)
            .where(demo, model.slug == slug, _no_image(model.image_url))
            .values(image_url=demo_image_url(path, image_base_url))
            .execution_options(synchronize_session=False)
        )
        updated += _rowcount(result)
    return updated, kept


async def set_demo_images(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    apply: bool,
    image_base_url: str | None = None,
) -> ImagesReport:
    """Set the demo photo URLs on demo rows without an image, in one transaction; rolled back
    unless ``apply``. Rows with an image URL and non-demo rows are never changed."""
    async with session_factory() as session:
        await _begin(session)
        categories_updated, categories_kept = await _backfill(
            session, Category, demo_category(), DEMO_CATEGORY_IMAGES, image_base_url
        )
        products_updated, products_kept = await _backfill(
            session, Product, demo_product(), DEMO_PRODUCT_IMAGES, image_base_url
        )
        report = ImagesReport(
            applied=apply,
            image_base_url=image_base_url,
            categories_updated=categories_updated,
            products_updated=products_updated,
            categories_kept=categories_kept,
            products_kept=products_kept,
        )
        if apply and report.changed:
            record_audit(
                session,
                AUDIT_ACTOR,
                action="catalog.demo_images",
                entity_type=AuditEntity.CATALOG,
                entity_id="demo",
                extra={"source": "demo", "updates": report.changed},
            )
        if apply:
            await session.commit()
        else:
            await session.rollback()
    return report


# --- command line ---------------------------------------------------------------------------------


def demo_database_url(environ: Mapping[str, str]) -> str:
    """The URL from ``DEMO_IMPORT_DATABASE_URL``, validated; errors never contain any of it."""
    raw = environ.get(DATABASE_URL_ENV, "").strip()
    if not raw:
        raise DemoCatalogError(
            f"{DATABASE_URL_ENV} is not set: export the migrator database URL from your secret "
            "store into it (never type it into a shell history or a file in the repository)"
        )
    try:
        url = make_url(raw)
    except (ArgumentError, ValueError):
        raise DemoCatalogError(f"{DATABASE_URL_ENV} is not a valid database URL") from None
    if url.drivername != "postgresql+asyncpg":
        raise DemoCatalogError(f"{DATABASE_URL_ENV} must use the postgresql+asyncpg:// scheme")
    if "sslmode" in url.query:
        raise DemoCatalogError(f"{DATABASE_URL_ENV} must use ssl= (asyncpg), not sslmode=")
    if url.host not in LOCAL_HOSTS and url.query.get("ssl") != DEPLOYED_SSL_MODE:
        raise DemoCatalogError(
            f"{DATABASE_URL_ENV} must set ssl={DEPLOYED_SSL_MODE} for a non-local database"
        )
    return raw


def create_demo_engine(url: str) -> AsyncEngine:
    return create_async_engine(
        url,
        poolclass=NullPool,
        hide_parameters=True,
        connect_args={"timeout": 15, "server_settings": {"application_name": APPLICATION_NAME}},
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ops.demo_catalog",
        description=(
            "Import, inspect or remove the synthetic demo catalog. Reads the database URL from "
            f"{DATABASE_URL_ENV}. import/remove are dry runs unless --confirm is given."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="count demo and real rows (read-only)")
    for name, phrase, summary in (
        ("import", IMPORT_PHRASE, "insert the demo catalog into an empty catalog"),
        ("remove", REMOVE_PHRASE, "delete or archive the demo rows only"),
        ("images", IMAGES_PHRASE, "set the demo photos on demo rows that have no image yet"),
    ):
        command = commands.add_parser(name, help=summary)
        command.add_argument(
            "--confirm",
            metavar="PHRASE",
            help=f'apply the change; must be exactly "{phrase}" (otherwise a dry run)',
        )
        if name != "remove":
            command.add_argument(
                "--image-base-url",
                metavar="URL",
                help=(
                    "store absolute photo URLs on this public https origin of the storefront "
                    f"(default: {IMAGE_BASE_URL_ENV}; without either, storefront paths such as "
                    "/products/banan.webp)"
                ),
            )
    return parser


def _dataset_summary() -> str:
    categories = production_categories()
    subcategories = sum(1 for category in categories if category.parent_slug)
    return (
        f"dataset: {len(categories) - subcategories} top-level categories, {subcategories} "
        f"subcategories, {len(production_products())} products, {len(SYNTHETIC_BRANDS)} invented "
        f"brands, {len(production_zones())} demo delivery zones"
    )


def _mode(applied: bool) -> str:
    return "applied" if applied else "DRY RUN, nothing was written"


def _format_status(status: CatalogStatus) -> list[str]:
    return [
        "demo catalog status (read-only):",
        f"  demo categories: {status.demo_categories}",
        f"  demo products: {status.demo_products} "
        f"({status.demo_products_archived} archived, {status.demo_products_in_orders} in orders)",
        f"  demo delivery zones: {status.demo_zones}",
        f"  real (non-demo) categories / products / delivery zones: {status.other_categories} / "
        f"{status.other_products} / {status.other_zones}",
        "  import allowed: "
        + ("yes" if status.import_allowed else "no (the catalog contains real data)"),
    ]


def _format_import(report: ImportReport) -> list[str]:
    lines = [
        f"demo catalog import ({_mode(report.applied)}):",
        f"  {_dataset_summary()}",
        f"  categories created: {report.categories_created}",
        f"  products created: {report.products_created}",
    ]
    if report.zones_skipped:
        lines.append("  delivery zones: skipped (real delivery zones exist; left unchanged)")
    else:
        lines.append(
            f"  demo delivery zones created: {report.zones_created} "
            f"(districts assigned: {report.districts_assigned})"
        )
    if report.changed == 0:
        lines.append("  nothing to do: the demo catalog is already present")
    lines.append(
        "  note: demo zones are placeholders; replace them with the real delivery rules in the "
        "admin panel before taking real orders"
    )
    lines.append(f"  image URLs: {_photos_on(report.image_base_url)}")
    if not report.applied:
        lines.append(f'  to apply, re-run with --confirm "{IMPORT_PHRASE}"')
    return lines


def _format_remove(report: RemoveReport) -> list[str]:
    lines = [
        f"demo catalog removal ({_mode(report.applied)}):",
        f"  products deleted: {report.products_deleted}",
        f"  products archived (referenced by orders): {report.products_archived}",
        f"  categories deleted: {report.categories_deleted}",
        f"  categories deactivated (still hold archived demo products): "
        f"{report.categories_deactivated}",
        f"  categories left unchanged (hold real products or subcategories): "
        f"{report.categories_kept}",
        f"  delivery zones deleted: {report.zones_deleted}",
        f"  delivery zones deactivated (referenced by orders): {report.zones_deactivated}",
        f"  delivery slots deleted / deactivated: {report.slots_deleted} / "
        f"{report.slots_deactivated}",
        f"  districts released: {report.districts_released}",
    ]
    if report.changed == 0:
        lines.append("  nothing to do: no removable demo rows")
    if not report.applied:
        lines.append(f'  to apply, re-run with --confirm "{REMOVE_PHRASE}"')
    return lines


def _photos_on(image_base_url: str | None) -> str:
    if image_base_url is None:
        return "demo photos as storefront paths (/products/..., /categories/...)"
    return f"demo photos on {image_base_url}"


def _format_images(report: ImagesReport) -> list[str]:
    lines = [
        f"demo images backfill ({_mode(report.applied)}):",
        f"  image URLs: {_photos_on(report.image_base_url)}",
        f"  categories updated: {report.categories_updated} "
        f"(left unchanged, already have an image: {report.categories_kept})",
        f"  products updated: {report.products_updated} "
        f"(left unchanged, already have an image: {report.products_kept})",
    ]
    if report.changed == 0:
        lines.append("  nothing to do: every demo row present already has an image")
    if not report.applied:
        lines.append(f'  to apply, re-run with --confirm "{IMAGES_PHRASE}"')
    return lines


@dataclass(frozen=True, slots=True)
class Options:
    command: str
    apply: bool
    image_base_url: str | None


def _options(args: argparse.Namespace, environ: Mapping[str, str]) -> Options:
    """Checks everything that needs no database; refusals raise ``DemoCatalogError``."""
    command: str = args.command
    confirm: str | None = getattr(args, "confirm", None)
    phrase = PHRASES.get(command)
    if confirm is not None and confirm != phrase:
        raise DemoCatalogError(
            f'refused: --confirm must be exactly "{phrase}"; nothing was changed'
        )
    argument: str | None = getattr(args, "image_base_url", None)
    raw = argument if argument is not None else environ.get(IMAGE_BASE_URL_ENV, "")
    try:
        image_base_url = validate_image_base_url(raw) if raw.strip() else None
    except InvalidImageBaseUrlError as exc:
        raise DemoCatalogError(f"refused: {exc}; nothing was changed") from None
    return Options(command=command, apply=confirm == phrase, image_base_url=image_base_url)


async def _execute(options: Options, factory: async_sessionmaker[AsyncSession]) -> list[str]:
    apply, base = options.apply, options.image_base_url
    if options.command == "status":
        return _format_status(await demo_catalog_status(factory))
    if options.command == "import":
        return _format_import(await import_demo_catalog(factory, apply=apply, image_base_url=base))
    if options.command == "images":
        return _format_images(await set_demo_images(factory, image_base_url=base, apply=apply))
    if options.command == "remove":
        return _format_remove(await remove_demo_catalog(factory, apply=apply))
    raise DemoCatalogError(f"unknown command {options.command!r}")


EngineFactory = Callable[[str], AsyncEngine]


async def run(
    argv: Sequence[str],
    environ: Mapping[str, str],
    *,
    engine_factory: EngineFactory = create_demo_engine,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    stdout = out or sys.stdout
    stderr = err or sys.stderr
    args = build_parser().parse_args(argv)
    try:
        options = _options(args, environ)
        url = demo_database_url(environ)
    except DemoCatalogError as exc:
        stderr.write(f"{exc}\n")
        return EXIT_USAGE

    engine = engine_factory(url)
    del url
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        lines = await _execute(options, factory)
    except DemoCatalogError as exc:
        stderr.write(f"{exc}\n")
        return EXIT_REFUSED
    except Exception as exc:  # its message may contain parts of the database URL
        stderr.write(
            f"failed ({type(exc).__name__}); nothing was committed. Details are withheld so "
            "that no part of the database URL is printed.\n"
        )
        return EXIT_FAILED
    finally:
        await engine.dispose()
    stdout.write("\n".join(lines) + "\n")
    return EXIT_OK


def main() -> int:
    # No log output at all: driver and pool messages can carry the host or user name.
    logging.getLogger().addHandler(logging.NullHandler())
    logging.getLogger("sqlalchemy").setLevel(logging.CRITICAL)
    return asyncio.run(run(sys.argv[1:], os.environ))


if __name__ == "__main__":
    raise SystemExit(main())
