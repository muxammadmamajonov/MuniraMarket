"""Admin catalog writes (categories, products, CSV import/export), behind a small interface.

Every write is one transaction that also appends its ``audit_log`` row(s) (``app.audit``), so a
change and its audit record commit or roll back together. Uniqueness (SKU, slugs) is enforced by
the database constraints; a violation is mapped to a typed error instead of being pre-checked
(a pre-check would race).

Locking:

- product update/archive/restore: the product row ``FOR UPDATE``;
- category parent change: a transaction-level advisory lock serialises every re-parenting, so
  two concurrent moves cannot together create a cycle the per-move check would miss; then the
  category row ``FOR UPDATE``;
- CSV import: the products named in the file ``FOR UPDATE`` in ascending id order (the same
  order checkout uses), then the snapshot is read and re-validated under those locks, including
  the ``updated_at`` staleness check (``stale_row``), so an order or an admin edit that committed
  after the export can never be overwritten by the file's older values.

Products are never deleted: ``archive`` sets ``archived_at`` and ``is_active = false`` (order lines
keep pointing at the product and carts show it as unavailable).
"""

import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Final, Protocol

from sqlalchemy import ColumnElement, delete, exists, func, literal, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditActor, AuditEntity, diff_fields, record_audit
from app.domain.catalog_csv import (
    MAX_ERRORS,
    PRODUCT_FIELDS,
    CatalogSnapshot,
    CsvRow,
    CsvRowError,
    ExistingProduct,
    ExportRow,
    ParsedCsv,
    PlannedChange,
    plan_import,
    referenced_slugs,
)
from app.models.catalog import Category, Product
from app.models.enums import Unit
from app.repositories.catalog import escape_like

# pg_advisory_xact_lock key for "the category tree is being re-parented" (arbitrary constant).
CATEGORY_TREE_LOCK: Final = 4_242_001
SKU_CONSTRAINT: Final = "uq_products_sku"
PRODUCT_SLUG_CONSTRAINT: Final = "uq_products_slug"
CATEGORY_SLUG_CONSTRAINT: Final = "uq_categories_slug"
CATEGORY_FIELDS: Final = ("slug", "name_uz", "name_ru", "parent_id", "image_url", "sort_order")
CATEGORY_AUDIT_FIELDS: Final = (*CATEGORY_FIELDS, "is_active")
PRODUCT_WRITE_FIELDS: Final = ("sku", *PRODUCT_FIELDS)


class ProductStatusFilter(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"
    ALL = "all"


# --- errors -----------------------------------------------------------------------------------


class AdminCatalogError(Exception):
    """Base of the admin catalog rule violations (mapped to API errors by the routes)."""


class CategoryNotFoundError(AdminCatalogError):
    """The category named in the path does not exist."""


class ReferencedCategoryNotFoundError(AdminCatalogError):
    """A ``parent_id`` / ``category_id`` in the request body does not exist."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


class CategoryCycleError(AdminCatalogError):
    pass


class CategoryNotEmptyError(AdminCatalogError):
    pass


class SlugTakenError(AdminCatalogError):
    pass


class SkuTakenError(AdminCatalogError):
    pass


class ProductNotFoundError(AdminCatalogError):
    pass


class ProductArchivedError(AdminCatalogError):
    pass


class InvalidOldPriceError(AdminCatalogError):
    """``old_price_uzs`` must be above ``price_uzs`` (checked on the merged values)."""


# --- records ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AdminCategoryRecord:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    slug: str
    name_uz: str
    name_ru: str
    image_url: str | None
    sort_order: int
    is_active: bool
    # Products in the category, archived ones included (they still block deleting it).
    product_count: int
    child_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AdminProductRecord:
    id: uuid.UUID
    sku: str
    slug: str
    category_id: uuid.UUID
    name_uz: str
    name_ru: str
    description_uz: str | None
    description_ru: str | None
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None
    stock_quantity: int | None
    image_url: str | None
    sort_order: int
    is_active: bool
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AdminProductPageRecord:
    items: tuple[AdminProductRecord, ...]
    total: int


@dataclass(frozen=True, slots=True)
class CsvImportOutcome:
    dry_run: bool
    applied: bool
    total_rows: int
    creates: int
    updates: int
    unchanged: int
    errors: tuple[CsvRowError, ...]
    errors_truncated: bool


class AdminCatalogRepository(Protocol):
    """Rule violations raise the ``AdminCatalogError`` subclasses above."""

    async def list_categories(self) -> list[AdminCategoryRecord]: ...

    async def create_category(
        self, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminCategoryRecord: ...

    async def update_category(
        self, category_id: uuid.UUID, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminCategoryRecord: ...

    async def delete_category(self, category_id: uuid.UUID, *, actor: AuditActor) -> None: ...

    async def list_products(
        self,
        *,
        query: str | None,
        category_id: uuid.UUID | None,
        status: ProductStatusFilter | None,
        page: int,
        page_size: int,
    ) -> AdminProductPageRecord: ...

    async def get_product(self, product_id: uuid.UUID) -> AdminProductRecord | None: ...

    async def create_product(
        self, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminProductRecord: ...

    async def update_product(
        self, product_id: uuid.UUID, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminProductRecord: ...

    async def archive_product(
        self, product_id: uuid.UUID, *, actor: AuditActor
    ) -> AdminProductRecord: ...

    async def restore_product(
        self, product_id: uuid.UUID, *, actor: AuditActor
    ) -> AdminProductRecord: ...

    async def export_rows(self) -> list[ExportRow]: ...

    async def import_csv(
        self, parsed: ParsedCsv, *, dry_run: bool, actor: AuditActor
    ) -> CsvImportOutcome: ...


# --- helpers ----------------------------------------------------------------------------------


def violated_constraint(error: IntegrityError) -> str | None:
    name = getattr(getattr(error.orig, "__cause__", None), "constraint_name", None)
    if name is None:
        name = getattr(error.orig, "constraint_name", None)
    return name if isinstance(name, str) else None


def _write_error(error: IntegrityError, *, reference_field: str) -> AdminCatalogError | None:
    name = violated_constraint(error) or ""
    if name == SKU_CONSTRAINT:
        return SkuTakenError()
    if name in (PRODUCT_SLUG_CONSTRAINT, CATEGORY_SLUG_CONSTRAINT):
        return SlugTakenError()
    if name.startswith("fk_"):
        return ReferencedCategoryNotFoundError(reference_field)
    return None


def _product_record(product: Product) -> AdminProductRecord:
    return AdminProductRecord(
        id=product.id,
        sku=product.sku,
        slug=product.slug,
        category_id=product.category_id,
        name_uz=product.name_uz,
        name_ru=product.name_ru,
        description_uz=product.description_uz,
        description_ru=product.description_ru,
        unit=product.unit,
        price_uzs=product.price_uzs,
        old_price_uzs=product.old_price_uzs,
        stock_quantity=product.stock_quantity,
        image_url=product.image_url,
        sort_order=product.sort_order,
        is_active=product.is_active,
        archived_at=product.archived_at,
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


def _snapshot_of(model: object, fields: Sequence[str]) -> dict[str, object]:
    return {name: getattr(model, name) for name in fields}


def _status_condition(status: ProductStatusFilter | None) -> ColumnElement[bool] | None:
    if status is None:
        return Product.archived_at.is_(None)
    conditions: dict[ProductStatusFilter, ColumnElement[bool] | None] = {
        ProductStatusFilter.ACTIVE: Product.is_active.is_(True),
        ProductStatusFilter.INACTIVE: (Product.is_active.is_(False))
        & Product.archived_at.is_(None),
        ProductStatusFilter.ARCHIVED: Product.archived_at.is_not(None),
        ProductStatusFilter.ALL: None,
    }
    return conditions[status]


def capped_errors(errors: Sequence[CsvRowError]) -> tuple[tuple[CsvRowError, ...], bool]:
    """Errors sorted by row (then column order of appearance), at most ``MAX_ERRORS``."""
    ordered = sorted(errors, key=lambda error: error.row)
    return tuple(ordered[:MAX_ERRORS]), len(ordered) > MAX_ERRORS


# --- SQLAlchemy implementation ----------------------------------------------------------------


class SqlAlchemyAdminCatalogRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    # --- categories ----------------------------------------------------------------------------

    def _category_select(self) -> Any:
        products = (
            select(Product.category_id.label("category_id"), func.count().label("n"))
            .group_by(Product.category_id)
            .subquery()
        )
        child = Category.__table__.alias("child")
        children = (
            select(child.c.parent_id.label("parent_id"), func.count().label("n"))
            .where(child.c.parent_id.is_not(None))
            .group_by(child.c.parent_id)
            .subquery()
        )
        return (
            select(
                Category,
                func.coalesce(products.c.n, 0).label("product_count"),
                func.coalesce(children.c.n, 0).label("child_count"),
            )
            .outerjoin(products, products.c.category_id == Category.id)
            .outerjoin(children, children.c.parent_id == Category.id)
        )

    @staticmethod
    def _category_record(row: Any) -> AdminCategoryRecord:
        category: Category = row[0]
        return AdminCategoryRecord(
            id=category.id,
            parent_id=category.parent_id,
            slug=category.slug,
            name_uz=category.name_uz,
            name_ru=category.name_ru,
            image_url=category.image_url,
            sort_order=category.sort_order,
            is_active=category.is_active,
            product_count=row.product_count,
            child_count=row.child_count,
            created_at=category.created_at,
            updated_at=category.updated_at,
        )

    async def _load_category(self, category_id: uuid.UUID) -> AdminCategoryRecord:
        row = (
            await self._session.execute(
                self._category_select()
                .where(Category.id == category_id)
                .execution_options(populate_existing=True)
            )
        ).one()
        return self._category_record(row)

    async def list_categories(self) -> list[AdminCategoryRecord]:
        rows = await self._session.execute(
            self._category_select().order_by(Category.sort_order, Category.name_uz, Category.id)
        )
        return [self._category_record(row) for row in rows]

    async def _category_exists(self, category_id: uuid.UUID) -> bool:
        return bool(
            (
                await self._session.execute(select(exists().where(Category.id == category_id)))
            ).scalar_one()
        )

    async def create_category(
        self, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminCategoryRecord:
        try:
            async with self._transaction():
                parent_id = values.get("parent_id")
                if parent_id is not None and not await self._category_exists(parent_id):
                    raise ReferencedCategoryNotFoundError("parent_id")
                category = Category(**values)
                self._session.add(category)
                await self._session.flush()
                record_audit(
                    self._session,
                    actor,
                    action="category.create",
                    entity_type=AuditEntity.CATEGORY,
                    entity_id=category.id,
                    changes={
                        name: (None, value)
                        for name, value in _snapshot_of(category, CATEGORY_AUDIT_FIELDS).items()
                    },
                )
                await self._session.flush()
                return await self._load_category(category.id)
        except IntegrityError as exc:
            mapped = _write_error(exc, reference_field="parent_id")
            if mapped is None:
                raise
            raise mapped from None

    async def _is_ancestor_or_self(self, category_id: uuid.UUID, of: uuid.UUID) -> bool:
        """Whether ``category_id`` is ``of`` or one of its ancestors."""
        tree = (
            select(Category.id, Category.parent_id)
            .where(Category.id == of)
            .cte("ancestors", recursive=True)
        )
        tree = tree.union(
            select(Category.id, Category.parent_id).join(tree, Category.id == tree.c.parent_id)
        )
        found = await self._session.execute(
            select(literal(1)).select_from(tree).where(tree.c.id == category_id).limit(1)
        )
        return found.first() is not None

    async def update_category(
        self, category_id: uuid.UUID, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminCategoryRecord:
        try:
            async with self._transaction():
                if "parent_id" in values:
                    await self._session.execute(
                        select(func.pg_advisory_xact_lock(CATEGORY_TREE_LOCK))
                    )
                category = (
                    await self._session.execute(
                        select(Category).where(Category.id == category_id).with_for_update()
                    )
                ).scalar_one_or_none()
                if category is None:
                    raise CategoryNotFoundError()
                parent_id = values.get("parent_id")
                if parent_id is not None and parent_id != category.parent_id:
                    if not await self._category_exists(parent_id):
                        raise ReferencedCategoryNotFoundError("parent_id")
                    if await self._is_ancestor_or_self(category_id, of=parent_id):
                        raise CategoryCycleError()
                before = _snapshot_of(category, CATEGORY_AUDIT_FIELDS)
                for name, value in values.items():
                    setattr(category, name, value)
                changes = diff_fields(before, _snapshot_of(category, CATEGORY_AUDIT_FIELDS))
                if changes:
                    await self._session.flush()
                    record_audit(
                        self._session,
                        actor,
                        action="category.update",
                        entity_type=AuditEntity.CATEGORY,
                        entity_id=category.id,
                        changes=changes,
                    )
                    await self._session.flush()
                return await self._load_category(category.id)
        except IntegrityError as exc:
            mapped = _write_error(exc, reference_field="parent_id")
            if mapped is None:
                raise
            raise mapped from None

    async def delete_category(self, category_id: uuid.UUID, *, actor: AuditActor) -> None:
        try:
            async with self._transaction():
                category = (
                    await self._session.execute(
                        select(Category).where(Category.id == category_id).with_for_update()
                    )
                ).scalar_one_or_none()
                if category is None:
                    raise CategoryNotFoundError()
                in_use = (
                    await self._session.execute(
                        select(
                            exists().where(Category.parent_id == category_id)
                            | exists().where(Product.category_id == category_id)
                        )
                    )
                ).scalar_one()
                if in_use:
                    raise CategoryNotEmptyError()
                slug = category.slug
                await self._session.execute(delete(Category).where(Category.id == category_id))
                record_audit(
                    self._session,
                    actor,
                    action="category.delete",
                    entity_type=AuditEntity.CATEGORY,
                    entity_id=category_id,
                    extra={"slug": slug},
                )
                await self._session.flush()
        except IntegrityError as exc:
            # A child or product was added concurrently (the foreign keys are RESTRICT).
            if (violated_constraint(exc) or "").startswith("fk_"):
                raise CategoryNotEmptyError() from None
            raise

    # --- products ------------------------------------------------------------------------------

    async def list_products(
        self,
        *,
        query: str | None,
        category_id: uuid.UUID | None,
        status: ProductStatusFilter | None,
        page: int,
        page_size: int,
    ) -> AdminProductPageRecord:
        conditions: list[ColumnElement[bool]] = []
        status_condition = _status_condition(status)
        if status_condition is not None:
            conditions.append(status_condition)
        if category_id is not None:
            conditions.append(Product.category_id == category_id)
        if query:
            pattern = f"%{escape_like(query)}%"
            conditions.append(
                or_(
                    Product.name_uz.ilike(pattern, escape="\\"),
                    Product.name_ru.ilike(pattern, escape="\\"),
                    Product.sku.ilike(pattern, escape="\\"),
                    Product.slug.ilike(pattern, escape="\\"),
                )
            )
        total = (
            await self._session.execute(
                select(func.count()).select_from(Product).where(*conditions)
            )
        ).scalar_one()
        offset = (page - 1) * page_size
        if offset >= total:
            return AdminProductPageRecord(items=(), total=total)
        products = await self._session.execute(
            select(Product)
            .where(*conditions)
            .order_by(Product.sort_order, Product.name_uz, Product.id)
            .limit(page_size)
            .offset(offset)
        )
        return AdminProductPageRecord(
            items=tuple(_product_record(product) for product in products.scalars()),
            total=total,
        )

    async def _load_product(self, product_id: uuid.UUID) -> AdminProductRecord:
        product = (
            await self._session.execute(
                select(Product)
                .where(Product.id == product_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        return _product_record(product)

    async def get_product(self, product_id: uuid.UUID) -> AdminProductRecord | None:
        product = await self._session.get(Product, product_id)
        return None if product is None else _product_record(product)

    async def _lock_product(self, product_id: uuid.UUID) -> Product:
        product = (
            await self._session.execute(
                select(Product).where(Product.id == product_id).with_for_update()
            )
        ).scalar_one_or_none()
        if product is None:
            raise ProductNotFoundError()
        return product

    async def create_product(
        self, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminProductRecord:
        try:
            async with self._transaction():
                if not await self._category_exists(values["category_id"]):
                    raise ReferencedCategoryNotFoundError("category_id")
                product = Product(**values)
                self._session.add(product)
                await self._session.flush()
                record_audit(
                    self._session,
                    actor,
                    action="product.create",
                    entity_type=AuditEntity.PRODUCT,
                    entity_id=product.id,
                    changes={
                        name: (None, value)
                        for name, value in _snapshot_of(product, PRODUCT_WRITE_FIELDS).items()
                    },
                )
                await self._session.flush()
                return await self._load_product(product.id)
        except IntegrityError as exc:
            mapped = _write_error(exc, reference_field="category_id")
            if mapped is None:
                raise
            raise mapped from None

    async def update_product(
        self, product_id: uuid.UUID, values: Mapping[str, Any], *, actor: AuditActor
    ) -> AdminProductRecord:
        try:
            async with self._transaction():
                product = await self._lock_product(product_id)
                if product.archived_at is not None:
                    raise ProductArchivedError()
                price = values.get("price_uzs", product.price_uzs)
                old_price = values.get("old_price_uzs", product.old_price_uzs)
                if old_price is not None and old_price <= price:
                    raise InvalidOldPriceError()
                new_category = values.get("category_id")
                if (
                    new_category is not None
                    and new_category != product.category_id
                    and not await self._category_exists(new_category)
                ):
                    raise ReferencedCategoryNotFoundError("category_id")
                before = _snapshot_of(product, PRODUCT_WRITE_FIELDS)
                for name, value in values.items():
                    setattr(product, name, value)
                changes = diff_fields(before, _snapshot_of(product, PRODUCT_WRITE_FIELDS))
                if changes:
                    await self._session.flush()
                    record_audit(
                        self._session,
                        actor,
                        action="product.update",
                        entity_type=AuditEntity.PRODUCT,
                        entity_id=product.id,
                        changes=changes,
                    )
                    await self._session.flush()
                return await self._load_product(product.id)
        except IntegrityError as exc:
            mapped = _write_error(exc, reference_field="category_id")
            if mapped is None:
                raise
            raise mapped from None

    async def archive_product(
        self, product_id: uuid.UUID, *, actor: AuditActor
    ) -> AdminProductRecord:
        async with self._transaction():
            product = await self._lock_product(product_id)
            if product.archived_at is None:
                was_active = product.is_active
                await self._session.execute(
                    update(Product)
                    .where(Product.id == product.id)
                    .values(archived_at=func.now(), is_active=False, updated_at=func.now())
                )
                record_audit(
                    self._session,
                    actor,
                    action="product.archive",
                    entity_type=AuditEntity.PRODUCT,
                    entity_id=product.id,
                    changes={"archived": (False, True), "is_active": (was_active, False)},
                    extra={"sku": product.sku},
                )
                await self._session.flush()
            return await self._load_product(product.id)

    async def restore_product(
        self, product_id: uuid.UUID, *, actor: AuditActor
    ) -> AdminProductRecord:
        async with self._transaction():
            product = await self._lock_product(product_id)
            if product.archived_at is not None:
                # Stays inactive: an admin re-activates it deliberately after checking it.
                product.archived_at = None
                await self._session.flush()
                record_audit(
                    self._session,
                    actor,
                    action="product.restore",
                    entity_type=AuditEntity.PRODUCT,
                    entity_id=product.id,
                    changes={"archived": (True, False)},
                    extra={"sku": product.sku},
                )
                await self._session.flush()
            return await self._load_product(product.id)

    # --- CSV -----------------------------------------------------------------------------------

    async def export_rows(self) -> list[ExportRow]:
        rows = await self._session.execute(
            select(Product, Category.slug.label("category_slug"))
            .join(Category, Category.id == Product.category_id)
            .where(Product.archived_at.is_(None))
            .order_by(Product.sku)
        )
        return [
            ExportRow(
                sku=product.sku,
                slug=product.slug,
                category_slug=category_slug,
                name_uz=product.name_uz,
                name_ru=product.name_ru,
                description_uz=product.description_uz,
                description_ru=product.description_ru,
                unit=product.unit,
                price_uzs=product.price_uzs,
                old_price_uzs=product.old_price_uzs,
                stock_quantity=product.stock_quantity,
                is_active=product.is_active,
                sort_order=product.sort_order,
                image_url=product.image_url,
                updated_at=product.updated_at,
            )
            for product, category_slug in rows
        ]

    async def _catalog_snapshot(self, rows: Sequence[CsvRow]) -> CatalogSnapshot:
        skus = [row.sku for row in rows]
        products = (
            (
                await self._session.execute(
                    select(Product)
                    .where(Product.sku.in_(skus))
                    .execution_options(populate_existing=True)
                )
            )
            .scalars()
            .all()
            if skus
            else []
        )
        slugs = referenced_slugs(rows)
        owners: dict[str, str] = {}
        if slugs:
            owner_rows = await self._session.execute(
                select(Product.slug, Product.sku).where(Product.slug.in_(slugs))
            )
            owners = dict(owner_rows.all())
        category_slugs = {row.category_slug for row in rows}
        categories: dict[str, uuid.UUID] = {}
        if category_slugs:
            category_rows = await self._session.execute(
                select(Category.slug, Category.id).where(Category.slug.in_(category_slugs))
            )
            categories = dict(category_rows.all())
        return CatalogSnapshot(
            products_by_sku={
                product.sku: ExistingProduct(
                    id=product.id,
                    sku=product.sku,
                    archived=product.archived_at is not None,
                    values=_snapshot_of(product, PRODUCT_FIELDS),
                    updated_at=product.updated_at,
                )
                for product in products
            },
            slug_owners=owners,
            category_ids=categories,
        )

    async def import_csv(
        self, parsed: ParsedCsv, *, dry_run: bool, actor: AuditActor
    ) -> CsvImportOutcome:
        """Validate everything; write all of it in this one transaction, or nothing."""
        will_write = not dry_run and not parsed.errors
        try:
            if will_write and parsed.rows:
                await self._session.execute(
                    select(Product.id)
                    .where(Product.sku.in_([row.sku for row in parsed.rows]))
                    .order_by(Product.id)
                    .with_for_update()
                )
            plan = plan_import(parsed.rows, await self._catalog_snapshot(parsed.rows))
            errors, truncated = capped_errors([*parsed.errors, *plan.errors])
            applied = will_write and not errors
            if applied:
                await self._apply(plan.changes, actor=actor)
                record_audit(
                    self._session,
                    actor,
                    action="catalog.import",
                    entity_type=AuditEntity.CATALOG,
                    entity_id="csv",
                    extra={
                        "source": "csv",
                        "rows": parsed.total_rows,
                        "creates": plan.count("create"),
                        "updates": plan.count("update"),
                        "unchanged": plan.count("unchanged"),
                    },
                )
                await self._session.commit()
            else:
                await self._session.rollback()
        except IntegrityError as exc:
            await self._session.rollback()
            mapped = _write_error(exc, reference_field="category_id")
            if mapped is None:
                raise
            raise mapped from None
        except BaseException:
            await self._session.rollback()
            raise
        return CsvImportOutcome(
            dry_run=dry_run,
            applied=applied,
            total_rows=parsed.total_rows,
            creates=plan.count("create"),
            updates=plan.count("update"),
            unchanged=plan.count("unchanged"),
            errors=errors,
            errors_truncated=truncated,
        )

    async def _apply(self, changes: Sequence[PlannedChange], *, actor: AuditActor) -> None:
        for change in changes:
            if change.kind == "create":
                product = Product(sku=change.sku, **change.values)
                self._session.add(product)
                await self._session.flush()
                record_audit(
                    self._session,
                    actor,
                    action="product.create",
                    entity_type=AuditEntity.PRODUCT,
                    entity_id=product.id,
                    changes={"sku": (None, change.sku), **change.changes},
                    extra={"source": "csv"},
                )
            elif change.kind == "update":
                existing = await self._session.get(Product, change.product_id)
                if existing is None:  # pragma: no cover - locked above, never deleted
                    raise ProductNotFoundError()
                for name, (_, value) in change.changes.items():
                    setattr(existing, name, value)
                record_audit(
                    self._session,
                    actor,
                    action="product.update",
                    entity_type=AuditEntity.PRODUCT,
                    entity_id=existing.id,
                    changes=change.changes,
                    extra={"source": "csv", "sku": change.sku},
                )
        await self._session.flush()
