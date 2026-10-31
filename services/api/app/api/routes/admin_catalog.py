"""Admin catalog management: categories and products (``admin`` role only).

Every route needs a Login Widget session of a user whose role (re-read on every request) is
``admin``; anyone else gets ``403 forbidden`` before anything is read, for existing and unknown ids
alike. Writes also need the CSRF token. Each change and its ``audit_log`` row commit together.
Products are never deleted: ``DELETE`` archives (soft-deletes) and ``POST .../restore`` undoes it.
Responses are ``Cache-Control: no-store``.
"""

import logging
import uuid
from typing import Annotated

from fastapi import Depends, Query, Response

from app.api.admin_deps import (
    ADMIN_READ_LIMIT,
    ADMIN_WRITE_LIMIT,
    AdminDep,
    AdminWriterDep,
    actor_of,
    back_office_router,
)
from app.api.deps import SessionDep
from app.core.errors import ApiError, error_responses
from app.repositories.admin_catalog import (
    AdminCatalogError,
    AdminCatalogRepository,
    CategoryCycleError,
    CategoryNotEmptyError,
    CategoryNotFoundError,
    InvalidOldPriceError,
    ProductArchivedError,
    ProductNotFoundError,
    ProductStatusFilter,
    ReferencedCategoryNotFoundError,
    SkuTakenError,
    SlugTakenError,
    SqlAlchemyAdminCatalogRepository,
)
from app.schemas.admin_catalog import (
    AdminCategory,
    AdminCategoryList,
    AdminProduct,
    AdminProductPage,
    CategoryCreateRequest,
    CategoryUpdateRequest,
    ProductCreateRequest,
    ProductUpdateRequest,
)

logger = logging.getLogger("app.admin.catalog")

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20
MAX_PAGE = 100_000

router = back_office_router("/admin", tags=["admin-catalog"])


def get_admin_catalog_repository(session: SessionDep) -> AdminCatalogRepository:
    return SqlAlchemyAdminCatalogRepository(session)


AdminCatalogRepositoryDep = Annotated[AdminCatalogRepository, Depends(get_admin_catalog_repository)]


def to_api_error(exc: AdminCatalogError) -> ApiError:
    """Map an admin catalog rule violation to its public error."""
    if isinstance(exc, ReferencedCategoryNotFoundError):
        return ApiError(
            422,
            "category_not_found",
            "Category not found",
            details=[{"loc": ["body", exc.field], "msg": "Category not found"}],
        )
    if isinstance(exc, InvalidOldPriceError):
        return ApiError(
            422,
            "validation_error",
            "Request validation failed",
            details=[
                {"loc": ["body", "old_price_uzs"], "msg": "old_price_uzs must be above price_uzs"}
            ],
        )
    simple: dict[type[AdminCatalogError], ApiError] = {
        CategoryNotFoundError: ApiError(404, "category_not_found", "Category not found"),
        ProductNotFoundError: ApiError(404, "product_not_found", "Product not found"),
        CategoryCycleError: ApiError(
            409, "category_cycle", "A category cannot be moved under itself or its descendants"
        ),
        CategoryNotEmptyError: ApiError(
            409, "category_not_empty", "The category still has subcategories or products"
        ),
        SlugTakenError: ApiError(409, "slug_taken", "Slug is already used"),
        SkuTakenError: ApiError(409, "sku_taken", "SKU is already used"),
        ProductArchivedError: ApiError(
            409, "product_archived", "The product is archived; restore it first"
        ),
    }
    return simple.get(type(exc), ApiError(500, "internal_error", "Internal server error"))


# --- categories -------------------------------------------------------------------------------


@router.get(
    "/categories",
    response_model=AdminCategoryList,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 429, 503),
)
async def list_categories(_: AdminDep, catalog: AdminCatalogRepositoryDep) -> AdminCategoryList:
    """Every category (inactive ones included) as a flat list with product and child counts."""
    records = await catalog.list_categories()
    return AdminCategoryList(items=[AdminCategory.from_record(record) for record in records])


@router.post(
    "/categories",
    response_model=AdminCategory,
    status_code=201,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 409, 422, 429, 503),
)
async def create_category(
    payload: CategoryCreateRequest, admin: AdminWriterDep, catalog: AdminCatalogRepositoryDep
) -> AdminCategory:
    """Create a category. ``409 slug_taken``; ``422 category_not_found`` for an unknown parent."""
    try:
        record = await catalog.create_category(payload.model_dump(), actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info("Category created: %s", record.id)
    return AdminCategory.from_record(record)


@router.patch(
    "/categories/{category_id}",
    response_model=AdminCategory,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdateRequest,
    admin: AdminWriterDep,
    catalog: AdminCatalogRepositoryDep,
) -> AdminCategory:
    """Change the fields sent. ``parent_id: null`` moves it to the top level; a parent that is the
    category itself or one of its descendants is ``409 category_cycle``."""
    try:
        record = await catalog.update_category(
            category_id, payload.changes(), actor=actor_of(admin)
        )
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    return AdminCategory.from_record(record)


@router.delete(
    "/categories/{category_id}",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def delete_category(
    category_id: uuid.UUID, admin: AdminWriterDep, catalog: AdminCatalogRepositoryDep
) -> Response:
    """Delete an empty category. ``409 category_not_empty`` while it has subcategories or any
    products (archived ones included)."""
    try:
        await catalog.delete_category(category_id, actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info("Category deleted: %s", category_id)
    return Response(status_code=204)


# --- products ---------------------------------------------------------------------------------


@router.get(
    "/products",
    response_model=AdminProductPage,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_products(  # noqa: PLR0917 - FastAPI injects every parameter
    _: AdminDep,
    catalog: AdminCatalogRepositoryDep,
    q: Annotated[str | None, Query(max_length=100)] = None,
    category_id: uuid.UUID | None = None,
    status: Annotated[
        ProductStatusFilter | None,
        Query(description="Default: everything except archived products"),
    ] = None,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> AdminProductPage:
    """Products by ``sort_order, name_uz, id``. ``q`` matches name (uz/ru), SKU or slug."""
    record = await catalog.list_products(
        query=(q or "").strip() or None,
        category_id=category_id,
        status=status,
        page=page,
        page_size=page_size,
    )
    return AdminProductPage.from_record(record, page=page, page_size=page_size)


@router.get(
    "/products/{product_id}",
    response_model=AdminProduct,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 404, 422, 429, 503),
)
async def get_product(
    product_id: uuid.UUID, _: AdminDep, catalog: AdminCatalogRepositoryDep
) -> AdminProduct:
    """One product, archived or not."""
    record = await catalog.get_product(product_id)
    if record is None:
        raise to_api_error(ProductNotFoundError())
    return AdminProduct.from_record(record)


@router.post(
    "/products",
    response_model=AdminProduct,
    status_code=201,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 409, 422, 429, 503),
)
async def create_product(
    payload: ProductCreateRequest, admin: AdminWriterDep, catalog: AdminCatalogRepositoryDep
) -> AdminProduct:
    """Create a product. ``409 sku_taken`` / ``slug_taken``; ``422 category_not_found``."""
    try:
        record = await catalog.create_product(payload.model_dump(), actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info("Product created: %s", record.id)
    return AdminProduct.from_record(record)


@router.patch(
    "/products/{product_id}",
    response_model=AdminProduct,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def update_product(
    product_id: uuid.UUID,
    payload: ProductUpdateRequest,
    admin: AdminWriterDep,
    catalog: AdminCatalogRepositoryDep,
) -> AdminProduct:
    """Change the fields sent. ``409 product_archived`` for an archived product (restore it
    first); ``old_price_uzs`` must stay above ``price_uzs`` after the change (422)."""
    try:
        record = await catalog.update_product(product_id, payload.changes(), actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    return AdminProduct.from_record(record)


@router.delete(
    "/products/{product_id}",
    response_model=AdminProduct,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 422, 429, 503),
)
async def archive_product(
    product_id: uuid.UUID, admin: AdminWriterDep, catalog: AdminCatalogRepositoryDep
) -> AdminProduct:
    """Archive (soft-delete): hidden everywhere and inactive; orders keep their line snapshots.
    Archiving an archived product changes nothing."""
    try:
        record = await catalog.archive_product(product_id, actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info("Product archived: %s", product_id)
    return AdminProduct.from_record(record)


@router.post(
    "/products/{product_id}/restore",
    response_model=AdminProduct,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 422, 429, 503),
)
async def restore_product(
    product_id: uuid.UUID, admin: AdminWriterDep, catalog: AdminCatalogRepositoryDep
) -> AdminProduct:
    """Un-archive. The product stays inactive until it is activated with ``PATCH``."""
    try:
        record = await catalog.restore_product(product_id, actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info("Product restored: %s", product_id)
    return AdminProduct.from_record(record)
