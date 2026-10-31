"""Admin catalog request/response models (categories, products, CSV import result).

Requests forbid unknown fields. PATCH bodies have only optional fields and change exactly the
fields that were sent (``model_fields_set``); ``null`` is accepted only for nullable columns.
Money is integer UZS. Text is trimmed; names are a single line; descriptions may contain
newlines and tabs but no other control characters.
"""

import math
import re
import uuid
from datetime import datetime
from typing import Annotated, Any, ClassVar, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.domain.catalog_csv import (
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_PRICE_UZS,
    MAX_SLUG_LENGTH,
    MAX_SORT_ORDER,
    MAX_STOCK,
    MIN_SORT_ORDER,
    Column,
    CsvRowError,
    RowErrorCode,
)
from app.domain.image_url import MAX_IMAGE_URL_LENGTH, validate_image_url
from app.models.enums import Unit
from app.repositories.admin_catalog import (
    AdminCategoryRecord,
    AdminProductPageRecord,
    AdminProductRecord,
    CsvImportOutcome,
)

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_CONTROL_MULTILINE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def _single_line(value: str) -> str:
    if _CONTROL.search(value):
        raise ValueError("must be a single line of text")
    return value


def _multi_line(value: str) -> str:
    value = value.replace("\r\n", "\n")
    if _CONTROL_MULTILINE.search(value):
        raise ValueError("contains control characters")
    return value


def _blank_to_none(value: str | None) -> str | None:
    return value or None


def _image_url(value: str | None) -> str | None:
    return None if value is None else validate_image_url(value)


Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=MAX_SLUG_LENGTH,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    ),
]
Sku = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"),
]
Name = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME_LENGTH),
    AfterValidator(_single_line),
]
Description = Annotated[
    Annotated[
        str,
        StringConstraints(strip_whitespace=True, max_length=MAX_DESCRIPTION_LENGTH),
        AfterValidator(_multi_line),
    ]
    | None,
    AfterValidator(_blank_to_none),
]
ImageUrl = Annotated[
    Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_IMAGE_URL_LENGTH)]
    | None,
    AfterValidator(_blank_to_none),
    AfterValidator(_image_url),
    Field(description="https URL of an already-hosted image, or null (never fetched)"),
]
Price = Annotated[int, Field(ge=0, le=MAX_PRICE_UZS)]
Stock = Annotated[int, Field(ge=0, le=MAX_STOCK)]
SortOrder = Annotated[int, Field(ge=MIN_SORT_ORDER, le=MAX_SORT_ORDER)]


class _PatchModel(BaseModel):
    """PATCH body: refuses ``null`` for non-nullable fields and an empty body."""

    model_config = ConfigDict(extra="forbid")
    NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def _check_nulls(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("send at least one field")
        for name in self.model_fields_set:
            if getattr(self, name) is None and name not in self.NULLABLE:
                raise ValueError(f"{name} cannot be null")
        return self

    def changes(self) -> dict[str, Any]:
        """Only the fields that were sent."""
        return {name: getattr(self, name) for name in self.model_fields_set}


# --- categories -------------------------------------------------------------------------------


class CategoryCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: Slug
    name_uz: Name
    name_ru: Name
    parent_id: uuid.UUID | None = None
    image_url: ImageUrl = None
    sort_order: SortOrder = 0
    is_active: bool = True


class CategoryUpdateRequest(_PatchModel):
    NULLABLE: ClassVar[frozenset[str]] = frozenset({"parent_id", "image_url"})

    slug: Slug | None = None
    name_uz: Name | None = None
    name_ru: Name | None = None
    # ``null`` moves the category to the top level.
    parent_id: uuid.UUID | None = None
    image_url: ImageUrl = None
    sort_order: SortOrder | None = None
    is_active: bool | None = None


class AdminCategory(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    slug: str
    name_uz: str
    name_ru: str
    image_url: str | None
    sort_order: int
    is_active: bool
    # Products in the category, archived ones included (they still block deletion).
    product_count: int
    child_count: int
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, record: AdminCategoryRecord) -> Self:
        return cls(
            id=record.id,
            parent_id=record.parent_id,
            slug=record.slug,
            name_uz=record.name_uz,
            name_ru=record.name_ru,
            image_url=record.image_url,
            sort_order=record.sort_order,
            is_active=record.is_active,
            product_count=record.product_count,
            child_count=record.child_count,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class AdminCategoryList(BaseModel):
    """Every category (inactive ones included), flat, by ``sort_order, name_uz, id``."""

    items: list[AdminCategory]


# --- products ---------------------------------------------------------------------------------


class ProductCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Sku
    slug: Slug
    category_id: uuid.UUID
    name_uz: Name
    name_ru: Name
    description_uz: Description = None
    description_ru: Description = None
    unit: Unit
    price_uzs: Price
    old_price_uzs: Price | None = Field(default=None, description="null, or above price_uzs")
    stock_quantity: Stock | None = None
    image_url: ImageUrl = None
    sort_order: SortOrder = 0
    is_active: bool = True

    @model_validator(mode="after")
    def _old_price_above_price(self) -> Self:
        if self.old_price_uzs is not None and self.old_price_uzs <= self.price_uzs:
            raise ValueError("old_price_uzs must be above price_uzs")
        return self


class ProductUpdateRequest(_PatchModel):
    """``is_active`` cannot be set on an archived product: restore it first."""

    NULLABLE: ClassVar[frozenset[str]] = frozenset(
        {"description_uz", "description_ru", "old_price_uzs", "stock_quantity", "image_url"}
    )

    sku: Sku | None = None
    slug: Slug | None = None
    category_id: uuid.UUID | None = None
    name_uz: Name | None = None
    name_ru: Name | None = None
    description_uz: Description = None
    description_ru: Description = None
    unit: Unit | None = None
    price_uzs: Price | None = None
    old_price_uzs: Price | None = None
    stock_quantity: Stock | None = None
    image_url: ImageUrl = None
    sort_order: SortOrder | None = None
    is_active: bool | None = None


class AdminProduct(BaseModel):
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
    # null = stock is not tracked for this product.
    stock_quantity: int | None
    image_url: str | None
    sort_order: int
    is_active: bool
    # Set when archived (soft-deleted); an archived product is always inactive.
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, record: AdminProductRecord) -> Self:
        return cls(
            id=record.id,
            sku=record.sku,
            slug=record.slug,
            category_id=record.category_id,
            name_uz=record.name_uz,
            name_ru=record.name_ru,
            description_uz=record.description_uz,
            description_ru=record.description_ru,
            unit=record.unit,
            price_uzs=record.price_uzs,
            old_price_uzs=record.old_price_uzs,
            stock_quantity=record.stock_quantity,
            image_url=record.image_url,
            sort_order=record.sort_order,
            is_active=record.is_active,
            archived_at=record.archived_at,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class AdminProductPage(BaseModel):
    items: list[AdminProduct]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = Field(ge=0)
    total_pages: int = Field(ge=0)

    @classmethod
    def from_record(cls, record: AdminProductPageRecord, *, page: int, page_size: int) -> Self:
        return cls(
            items=[AdminProduct.from_record(item) for item in record.items],
            page=page,
            page_size=page_size,
            total=record.total,
            total_pages=math.ceil(record.total / page_size),
        )


# --- CSV --------------------------------------------------------------------------------------


class CsvRowErrorOut(BaseModel):
    # 1-based data row; the header is row 0.
    row: int
    column: Column | None
    code: RowErrorCode
    message: str

    @classmethod
    def from_error(cls, error: CsvRowError) -> Self:
        return cls(row=error.row, column=error.column, code=error.code, message=error.message)


class CsvImportResult(BaseModel):
    """``applied`` is true only when the file had no errors and ``dry_run`` was false."""

    dry_run: bool
    applied: bool
    total_rows: int
    creates: int
    updates: int
    unchanged: int
    errors: list[CsvRowErrorOut]
    # More than 200 errors: only the first 200 (by row) are listed.
    errors_truncated: bool

    @classmethod
    def from_outcome(cls, outcome: CsvImportOutcome) -> Self:
        return cls(
            dry_run=outcome.dry_run,
            applied=outcome.applied,
            total_rows=outcome.total_rows,
            creates=outcome.creates,
            updates=outcome.updates,
            unchanged=outcome.unchanged,
            errors=[CsvRowErrorOut.from_error(error) for error in outcome.errors],
            errors_truncated=outcome.errors_truncated,
        )
