"""Public catalog (no authentication): categories and products.

Successful responses are ``Cache-Control: public, max-age=60``. Every route is rate limited per
IP (``catalog_ip``) before any database work; a ``429`` is ``no-store`` so no shared cache keeps
serving it.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import StringConstraints

from app.api.auth_deps import rate_limit
from app.api.deps import SessionDep
from app.core.errors import ApiError, error_responses
from app.repositories.catalog import (
    CatalogRepository,
    CategoryNotFoundError,
    ProductSort,
    SqlAlchemyCatalogRepository,
    total_pages,
)
from app.schemas.catalog import CategoryNode, CategoryTree, ProductDetail, ProductPage
from app.security.rate_limit import CATALOG_IP

MAX_PAGE_SIZE = 48
DEFAULT_PAGE_SIZE = 24
# Far beyond any real catalog; only keeps (page - 1) * page_size inside a database bigint.
MAX_PAGE = 1_000_000


async def public_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "public, max-age=60"


# Module-level so tests can replace this exact dependency object in ``dependency_overrides``.
CATALOG_IP_LIMIT = rate_limit(
    CATALOG_IP.scope, CATALOG_IP.limit, CATALOG_IP.window_seconds, key="ip"
)

router = APIRouter(
    tags=["catalog"], dependencies=[Depends(CATALOG_IP_LIMIT), Depends(public_cache)]
)


def get_catalog_repository(session: SessionDep) -> CatalogRepository:
    return SqlAlchemyCatalogRepository(session)


CatalogRepositoryDep = Annotated[CatalogRepository, Depends(get_catalog_repository)]

# Trimmed before validation, so "  a " is too short and "  milk  " searches for "milk".
SearchText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=100)]


@router.get("/categories", response_model=CategoryTree, responses=error_responses(429, 503))
async def list_categories(catalog: CatalogRepositoryDep) -> CategoryTree:
    """Active categories as a tree. An inactive category hides its whole subtree."""
    records = await catalog.list_category_tree()
    return CategoryTree(items=[CategoryNode.from_record(record) for record in records])


@router.get(
    "/products",
    response_model=ProductPage,
    responses=error_responses(404, 422, 429, 503),
)
async def list_products(
    catalog: CatalogRepositoryDep,
    *,
    category: Annotated[
        str | None,
        Query(
            min_length=1,
            max_length=128,
            description="Category slug; includes all active descendant categories.",
        ),
    ] = None,
    q: Annotated[
        SearchText | None,
        Query(
            description="Case-insensitive substring of name (uz/ru) or SKU; 2-100 characters "
            "after trimming. `%`, `_` and `\\` are matched literally."
        ),
    ] = None,
    sort: Annotated[ProductSort, Query()] = ProductSort.NEWEST,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> ProductPage:
    """Active products in active categories, with stable pagination."""
    try:
        result = await catalog.list_products(
            category_slug=category, query=q, sort=sort, page=page, page_size=page_size
        )
    except CategoryNotFoundError:
        raise ApiError(404, "category_not_found", "Category not found") from None
    return ProductPage.from_record(
        result,
        page=page,
        page_size=page_size,
        total_pages=total_pages(result.total, page_size),
    )


@router.get(
    "/products/{slug}",
    response_model=ProductDetail,
    responses=error_responses(404, 422, 429, 503),
)
async def get_product(
    slug: Annotated[str, Path(min_length=1, max_length=160)],
    catalog: CatalogRepositoryDep,
) -> ProductDetail:
    """One product. Missing, inactive and products in inactive categories all return 404."""
    record = await catalog.get_product_by_slug(slug)
    if record is None:
        raise ApiError(404, "product_not_found", "Product not found")
    return ProductDetail.from_detail_record(record)
