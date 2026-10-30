"""Public catalog response models. Money is integer UZS; ``stock_quantity`` null = not tracked."""

import uuid
from typing import Self

from pydantic import BaseModel, Field

from app.domain.cart import is_in_stock
from app.models.enums import Unit
from app.repositories.catalog import (
    CategoryNodeRecord,
    CategoryRefRecord,
    ProductDetailRecord,
    ProductPageRecord,
    ProductSummaryRecord,
)


class CategoryNode(BaseModel):
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str
    image_url: str | None
    sort_order: int
    children: list["CategoryNode"]

    @classmethod
    def from_record(cls, record: CategoryNodeRecord) -> Self:
        return cls(
            id=record.id,
            slug=record.slug,
            name_uz=record.name_uz,
            name_ru=record.name_ru,
            image_url=record.image_url,
            sort_order=record.sort_order,
            children=[cls.from_record(child) for child in record.children],
        )


class CategoryTree(BaseModel):
    items: list[CategoryNode]


class CategoryRef(BaseModel):
    id: uuid.UUID
    slug: str
    name_uz: str
    name_ru: str

    @classmethod
    def from_record(cls, record: CategoryRefRecord) -> Self:
        return cls(id=record.id, slug=record.slug, name_uz=record.name_uz, name_ru=record.name_ru)


class ProductSummary(BaseModel):
    id: uuid.UUID
    slug: str
    sku: str
    name_uz: str
    name_ru: str
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None
    # null = stock is not tracked for this product.
    stock_quantity: int | None
    in_stock: bool
    image_url: str | None
    category_id: uuid.UUID

    @classmethod
    def from_record(cls, record: ProductSummaryRecord) -> Self:
        return cls(
            id=record.id,
            slug=record.slug,
            sku=record.sku,
            name_uz=record.name_uz,
            name_ru=record.name_ru,
            unit=record.unit,
            price_uzs=record.price_uzs,
            old_price_uzs=record.old_price_uzs,
            stock_quantity=record.stock_quantity,
            in_stock=is_in_stock(record.stock_quantity),
            image_url=record.image_url,
            category_id=record.category_id,
        )


class ProductDetail(ProductSummary):
    description_uz: str | None
    description_ru: str | None
    brand: str | None
    category: CategoryRef

    @classmethod
    def from_detail_record(cls, record: ProductDetailRecord) -> Self:
        summary = ProductSummary.from_record(record.summary)
        return cls(
            **summary.model_dump(),
            description_uz=record.description_uz,
            description_ru=record.description_ru,
            brand=record.brand,
            category=CategoryRef.from_record(record.category),
        )


class ProductPage(BaseModel):
    items: list[ProductSummary]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = Field(ge=0)
    total_pages: int = Field(ge=0)

    @classmethod
    def from_record(
        cls, record: ProductPageRecord, *, page: int, page_size: int, total_pages: int
    ) -> Self:
        return cls(
            items=[ProductSummary.from_record(item) for item in record.items],
            page=page,
            page_size=page_size,
            total=record.total,
            total_pages=total_pages,
        )
