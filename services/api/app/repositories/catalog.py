"""Public catalog reads behind a small interface so routes can be tested without a database.

Visibility rule used everywhere: a category is *visible* when it and every ancestor is active; a
product is *visible* when it is active and its category is visible. An inactive category therefore
hides its whole subtree and all products in it.
"""

import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from sqlalchemy import CTE, ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.catalog import Category, Product
from app.models.enums import Unit


class ProductSort(StrEnum):
    NEWEST = "newest"
    PRICE_ASC = "price_asc"
    PRICE_DESC = "price_desc"
    NAME = "name"


class CategoryNotFoundError(Exception):
    """Unknown slug, or the category (or one of its ancestors) is inactive."""


@dataclass(frozen=True, slots=True)
class CategoryNodeRecord:
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str
    image_url: str | None
    sort_order: int
    children: tuple["CategoryNodeRecord", ...]


@dataclass(frozen=True, slots=True)
class CategoryRefRecord:
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str


@dataclass(frozen=True, slots=True)
class ProductSummaryRecord:
    id: uuid.UUID
    slug: str
    sku: str
    name_uz: str
    name_ru: str
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None
    stock_quantity: int | None
    image_url: str | None
    category_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class ProductDetailRecord:
    summary: ProductSummaryRecord
    description_uz: str | None
    description_ru: str | None
    brand: str | None
    category: CategoryRefRecord


@dataclass(frozen=True, slots=True)
class ProductPageRecord:
    items: tuple[ProductSummaryRecord, ...]
    total: int


class CatalogRepository(Protocol):
    async def list_category_tree(self) -> list[CategoryNodeRecord]: ...

    async def list_products(
        self,
        *,
        category_slug: str | None,
        query: str | None,
        sort: ProductSort,
        page: int,
        page_size: int,
    ) -> ProductPageRecord:
        """Raises ``CategoryNotFoundError`` for an unknown or hidden ``category_slug``."""
        ...

    async def get_product_by_slug(self, slug: str) -> ProductDetailRecord | None: ...


# --- pure helpers -------------------------------------------------------------------------------


def escape_like(value: str) -> str:
    """Escape backslash, ``%`` and ``_`` so input matches literally under ``ESCAPE '\\'``."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@dataclass(frozen=True, slots=True)
class CategoryRow:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    slug: str
    name_uz: str
    name_ru: str
    image_url: str | None
    sort_order: int


def build_category_tree(rows: Sequence[CategoryRow]) -> list[CategoryNodeRecord]:
    """Nest already-ordered rows under their parents, keeping the given order at every level.

    Rows whose parent is not part of ``rows`` are dropped (they are not reachable from a root).
    """
    by_parent: dict[uuid.UUID | None, list[CategoryRow]] = defaultdict(list)
    for row in rows:
        by_parent[row.parent_id].append(row)

    def nodes(parent_id: uuid.UUID | None) -> tuple[CategoryNodeRecord, ...]:
        return tuple(
            CategoryNodeRecord(
                id=row.id,
                slug=row.slug,
                name_uz=row.name_uz,
                name_ru=row.name_ru,
                image_url=row.image_url,
                sort_order=row.sort_order,
                children=nodes(row.id),
            )
            for row in by_parent.get(parent_id, [])
        )

    return list(nodes(None))


def total_pages(total: int, page_size: int) -> int:
    return -(-total // page_size)


# --- SQL building blocks (shared with the cart repository) ---------------------------------------


def visible_category_cte() -> CTE:
    """Categories that are active with all ancestors active (recursive CTE from the roots down)."""
    roots = (
        select(Category.id, Category.parent_id, Category.slug)
        .where(Category.parent_id.is_(None), Category.is_active.is_(True))
        .cte("visible_category", recursive=True)
    )
    children = (
        select(Category.id, Category.parent_id, Category.slug)
        .join(roots, Category.parent_id == roots.c.id)
        .where(Category.is_active.is_(True))
    )
    return roots.union_all(children)


def product_is_visible(visible: CTE) -> ColumnElement[bool]:
    return and_(Product.is_active.is_(True), Product.category_id.in_(select(visible.c.id)))


PRODUCT_SUMMARY_COLUMNS = (
    Product.id,
    Product.slug,
    Product.sku,
    Product.name_uz,
    Product.name_ru,
    Product.unit,
    Product.price_uzs,
    Product.old_price_uzs,
    Product.stock_quantity,
    Product.image_url,
    Product.category_id,
)


def summary_from_row(row: Any) -> ProductSummaryRecord:
    """Build a record from any row selecting ``PRODUCT_SUMMARY_COLUMNS``."""
    return ProductSummaryRecord(
        id=row.id,
        slug=row.slug,
        sku=row.sku,
        name_uz=row.name_uz,
        name_ru=row.name_ru,
        unit=row.unit,
        price_uzs=row.price_uzs,
        old_price_uzs=row.old_price_uzs,
        stock_quantity=row.stock_quantity,
        image_url=row.image_url,
        category_id=row.category_id,
    )


def _order_by(sort: ProductSort) -> list[ColumnElement[Any]]:
    """Every ordering ends with ``id`` so pages never overlap or skip equal-keyed rows."""
    match sort:
        case ProductSort.NEWEST:
            return [Product.created_at.desc(), Product.id.desc()]
        case ProductSort.PRICE_ASC:
            return [Product.price_uzs.asc(), Product.id.asc()]
        case ProductSort.PRICE_DESC:
            return [Product.price_uzs.desc(), Product.id.asc()]
        case ProductSort.NAME:
            return [Product.name_uz.asc(), Product.id.asc()]


def _search_filter(query: str) -> ColumnElement[bool]:
    pattern = f"%{escape_like(query)}%"
    return or_(
        Product.name_uz.ilike(pattern, escape="\\"),
        Product.name_ru.ilike(pattern, escape="\\"),
        Product.sku.ilike(pattern, escape="\\"),
    )


# --- SQLAlchemy implementation -------------------------------------------------------------------


class SqlAlchemyCatalogRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_category_tree(self) -> list[CategoryNodeRecord]:
        visible = visible_category_cte()
        statement = (
            select(
                Category.id,
                Category.parent_id,
                Category.slug,
                Category.name_uz,
                Category.name_ru,
                Category.image_url,
                Category.sort_order,
            )
            .join(visible, visible.c.id == Category.id)
            .order_by(Category.sort_order, Category.name_uz, Category.id)
        )
        rows = (await self._session.execute(statement)).all()
        return build_category_tree(
            [
                CategoryRow(
                    id=row.id,
                    parent_id=row.parent_id,
                    slug=row.slug,
                    name_uz=row.name_uz,
                    name_ru=row.name_ru,
                    image_url=row.image_url,
                    sort_order=row.sort_order,
                )
                for row in rows
            ]
        )

    async def list_products(
        self,
        *,
        category_slug: str | None,
        query: str | None,
        sort: ProductSort,
        page: int,
        page_size: int,
    ) -> ProductPageRecord:
        visible = visible_category_cte()
        conditions: list[ColumnElement[bool]] = [Product.is_active.is_(True)]

        if category_slug is None:
            conditions.append(Product.category_id.in_(select(visible.c.id)))
        else:
            category_id = (
                await self._session.execute(
                    select(visible.c.id).where(visible.c.slug == category_slug)
                )
            ).scalar_one_or_none()
            if category_id is None:
                raise CategoryNotFoundError(category_slug)
            # The category and all of its visible descendants (a recursive walk over `visible`).
            subtree = (
                select(visible.c.id)
                .where(visible.c.id == category_id)
                .cte("subtree", recursive=True)
            )
            subtree = subtree.union_all(
                select(visible.c.id).join(subtree, visible.c.parent_id == subtree.c.id)
            )
            conditions.append(Product.category_id.in_(select(subtree.c.id)))

        if query is not None:
            conditions.append(_search_filter(query))

        total = (
            await self._session.execute(
                select(func.count()).select_from(Product).where(*conditions)
            )
        ).scalar_one()
        offset = (page - 1) * page_size
        if offset >= total:
            return ProductPageRecord(items=(), total=total)

        rows = (
            await self._session.execute(
                select(*PRODUCT_SUMMARY_COLUMNS)
                .where(*conditions)
                .order_by(*_order_by(sort))
                .limit(page_size)
                .offset(offset)
            )
        ).all()
        return ProductPageRecord(items=tuple(summary_from_row(row) for row in rows), total=total)

    async def get_product_by_slug(self, slug: str) -> ProductDetailRecord | None:
        visible = visible_category_cte()
        statement = (
            select(
                *PRODUCT_SUMMARY_COLUMNS,
                Product.description_uz,
                Product.description_ru,
                Product.brand,
                Category.slug.label("category_slug"),
                Category.name_uz.label("category_name_uz"),
                Category.name_ru.label("category_name_ru"),
            )
            .join(Category, Category.id == Product.category_id)
            .where(Product.slug == slug, product_is_visible(visible))
        )
        row = (await self._session.execute(statement)).first()
        if row is None:
            return None
        return ProductDetailRecord(
            summary=summary_from_row(row),
            description_uz=row.description_uz,
            description_ru=row.description_ru,
            brand=row.brand,
            category=CategoryRefRecord(
                id=row.category_id,
                slug=row.category_slug,
                name_uz=row.category_name_uz,
                name_ru=row.category_name_ru,
            ),
        )
