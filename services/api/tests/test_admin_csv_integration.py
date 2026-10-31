"""Catalog CSV export/import over HTTP against a real PostgreSQL schema.

The import is all-or-nothing: one bad row among valid ones, a dry run, or a lost race must leave
the ``products`` table and the audit log exactly as they were.
"""

import asyncio
import csv
import io
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import func, select

from app.domain.catalog_csv import BOM, COLUMNS
from app.models.audit import AuditLog
from app.models.catalog import Category, Product
from app.models.enums import UserRole
from app.repositories.users import UserRecord
from tests.admin_factories import CSV_HEADERS, audit_rows, build_admin_app, error_of
from tests.db_data import TEST_USER_HEADER, SessionFactory, add_category, add_product, add_user
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

CSV = "/api/v1/admin/catalog/csv"
PRODUCTS = "/api/v1/admin/products"


@dataclass
class Shop:
    client: httpx.AsyncClient
    factory: SessionFactory
    admin: UserRecord
    fruit: Category
    vegetables: Category

    @property
    def headers(self) -> dict[str, str]:
        return {TEST_USER_HEADER: str(self.admin.id)}

    async def upload(self, raw: bytes, *, dry_run: bool = False) -> httpx.Response:
        return await self.client.post(
            f"{CSV}/import",
            params={"dry_run": str(dry_run).lower()},
            content=raw,
            headers={**self.headers, **CSV_HEADERS},
        )

    async def export(self) -> bytes:
        response = await self.client.get(f"{CSV}/export", headers=self.headers)
        assert response.status_code == 200, response.text
        return response.content

    async def products(self) -> list[tuple[Any, ...]]:
        """Every column of every product row, for before/after comparisons."""
        async with self.factory() as session:
            rows = await session.execute(select(Product.__table__).order_by(Product.sku))
            return [tuple(row) for row in rows]

    async def audit_count(self) -> int:
        async with self.factory() as session:
            return (await session.execute(select(func.count()).select_from(AuditLog))).scalar_one()


@pytest_asyncio.fixture(loop_scope="module")
async def shop(session_factory: SessionFactory) -> AsyncIterator[Shop]:
    admin = await add_user(session_factory, role=UserRole.ADMIN)
    fruit = await add_category(session_factory, "mevalar")
    vegetables = await add_category(session_factory, "sabzavotlar")
    app = build_admin_app(session_factory, [admin])
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Shop(client, session_factory, admin, fruit, vegetables)


def csv_row(**overrides: str) -> dict[str, str]:
    values = {
        "sku": "DEMO-NEW",
        "slug": "",
        "category_slug": "mevalar",
        "name_uz": "Yangi olma",
        "name_ru": "Новое яблоко",
        "description_uz": "",
        "description_ru": "",
        "unit": "kg",
        "price_uzs": "15000",
        "old_price_uzs": "",
        "stock_quantity": "10",
        "is_active": "true",
        "sort_order": "0",
        "image_url": "",
    }
    values.update(overrides)
    return values


def to_csv(rows: list[dict[str, str]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for values in rows:
        writer.writerow([values[column] for column in COLUMNS])
    return (BOM + buffer.getvalue()).encode("utf-8")


async def seed(shop: Shop) -> None:
    await add_product(shop.factory, shop.fruit, "olma", sku="DEMO-OLMA", price=12_000, stock=5)
    await add_product(shop.factory, shop.vegetables, "piyoz", sku="DEMO-PIYOZ", price=4_000)


async def test_bad_row_among_valid_ones_writes_nothing(shop: Shop) -> None:
    await seed(shop)
    before, audit_before = await shop.products(), await shop.audit_count()
    raw = to_csv(
        [
            csv_row(),
            csv_row(sku="DEMO-OLMA", slug="olma", price_uzs="13000"),
            csv_row(sku="DEMO-BAD", price_uzs="12,5"),
            csv_row(sku="DEMO-NEW2", category_slug="mevalar"),
        ]
    )
    response = await shop.upload(raw)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["applied"] is False
    assert result["dry_run"] is False
    assert result["total_rows"] == 4
    assert result["errors"] == [
        {
            "row": 3,
            "column": "price_uzs",
            "code": "invalid_money",
            "message": "Whole UZS: digits only, at most 10^12",
        }
    ]
    assert await shop.products() == before
    assert await shop.audit_count() == audit_before


async def test_database_level_errors_write_nothing(shop: Shop) -> None:
    await seed(shop)
    await add_product(
        shop.factory, shop.fruit, "eski", sku="DEMO-ESKI", is_active=False, archived_at=func.now()
    )
    before, audit_before = await shop.products(), await shop.audit_count()
    raw = to_csv(
        [
            csv_row(),
            csv_row(sku="DEMO-X", category_slug="yoq"),
            csv_row(sku="DEMO-ESKI"),
            csv_row(sku="DEMO-Y", slug="piyoz"),
        ]
    )
    result = (await shop.upload(raw)).json()
    assert result["applied"] is False
    assert [(error["row"], error["code"]) for error in result["errors"]] == [
        (2, "category_not_found"),
        (3, "product_archived"),
        (4, "slug_taken"),
    ]
    assert await shop.products() == before
    assert await shop.audit_count() == audit_before


async def test_dry_run_never_writes(shop: Shop) -> None:
    await seed(shop)
    before = await shop.products()
    raw = to_csv([csv_row(), csv_row(sku="DEMO-OLMA", slug="olma", price_uzs="13000")])
    response = await shop.upload(raw, dry_run=True)
    assert response.status_code == 200
    assert response.json() == {
        "dry_run": True,
        "applied": False,
        "total_rows": 2,
        "creates": 1,
        "updates": 1,
        "unchanged": 0,
        "errors": [],
        "errors_truncated": False,
    }
    assert await shop.products() == before
    assert await shop.audit_count() == 0


async def test_clean_import_creates_and_updates_with_audit(shop: Shop) -> None:
    await seed(shop)
    raw = to_csv(
        [
            csv_row(),
            csv_row(
                sku="DEMO-OLMA",
                slug="olma",
                name_uz="Demo olma",
                name_ru="Демо olma",
                unit="piece",
                price_uzs="13000",
                old_price_uzs="16000",
                stock_quantity="",
                category_slug="sabzavotlar",
            ),
        ]
    )
    response = await shop.upload(raw)
    assert response.status_code == 200, response.text
    result = response.json()
    assert (result["applied"], result["creates"], result["updates"]) == (True, 1, 1)

    async with shop.factory() as session:
        created = (
            await session.execute(select(Product).where(Product.sku == "DEMO-NEW"))
        ).scalar_one()
        updated = (
            await session.execute(select(Product).where(Product.sku == "DEMO-OLMA"))
        ).scalar_one()
    assert created.slug == "demo-new"
    assert created.stock_quantity == 10
    assert (updated.price_uzs, updated.old_price_uzs, updated.stock_quantity) == (
        13_000,
        16_000,
        None,
    )
    assert updated.category_id == shop.vegetables.id

    rows = await audit_rows(shop.factory)
    assert [(row.action, row.entity_id) for row in rows] == [
        ("product.create", str(created.id)),
        ("product.update", str(updated.id)),
        ("catalog.import", "csv"),
    ]
    create_row, update_row, summary = rows
    assert create_row.details["source"] == "csv"
    assert create_row.details["changes"]["sku"] == {"from": None, "to": "DEMO-NEW"}
    assert update_row.details == {
        "changes": {
            "category_id": {"from": str(shop.fruit.id), "to": str(shop.vegetables.id)},
            "price_uzs": {"from": 12_000, "to": 13_000},
            "old_price_uzs": {"from": None, "to": 16_000},
            "stock_quantity": {"from": 5, "to": None},
        },
        "source": "csv",
        "sku": "DEMO-OLMA",
    }
    assert summary.details == {
        "source": "csv",
        "rows": 2,
        "creates": 1,
        "updates": 1,
        "unchanged": 0,
    }
    assert summary.actor_user_id == shop.admin.id

    # Importing the same file again changes nothing and audits only the summary.
    again = (await shop.upload(raw)).json()
    assert (again["applied"], again["creates"], again["updates"], again["unchanged"]) == (
        True,
        0,
        0,
        2,
    )
    assert [row.action for row in await audit_rows(shop.factory)][-1] == "catalog.import"
    assert len(await audit_rows(shop.factory)) == 4


async def test_export_then_import_is_unchanged(shop: Shop) -> None:
    await seed(shop)
    tricky = [
        '=HYPERLINK("https://evil.example","bosing")',
        "+cmd|' /C calc'!A0",
        "@SUM(1+1)",
        "-2+3",
        "'qo'shtirnoq",
    ]
    for index, name in enumerate(tricky):
        response = await shop.client.post(
            PRODUCTS,
            json={
                "sku": f"DEMO-T{index}",
                "slug": f"demo-t{index}",
                "category_id": str(shop.fruit.id),
                "name_uz": name,
                "name_ru": name,
                "description_uz": f"{name}\nikkinchi qator",
                "unit": "piece",
                "price_uzs": 1000 + index,
                "image_url": "https://cdn.example.com/t.png",
            },
            headers=shop.headers,
        )
        assert response.status_code == 201, response.text
    await add_product(
        shop.factory, shop.fruit, "arxiv", sku="DEMO-ARXIV", is_active=False, archived_at=func.now()
    )

    exported = await shop.export()
    text = exported.decode("utf-8")
    assert text.startswith(BOM)
    assert "DEMO-ARXIV" not in text
    records = list(csv.reader(io.StringIO(text.removeprefix(BOM), newline="")))
    assert records[0] == list(COLUMNS)
    assert [record[0] for record in records[1:]] == sorted(record[0] for record in records[1:])
    for record in records[1:]:
        for cell in record:
            assert cell[:1] not in {"=", "+", "@", "\t", "\r"}
            assert not (cell[:1] == "-" and not cell.lstrip("-").isdigit())

    before, audit_before = await shop.products(), await shop.audit_count()
    result = (await shop.upload(exported)).json()
    assert result["errors"] == []
    assert (result["applied"], result["creates"], result["updates"]) == (True, 0, 0)
    assert result["unchanged"] == len(tricky) + 2
    assert await shop.products() == before
    assert await shop.audit_count() == audit_before + 1  # the catalog.import summary only


async def test_import_file_errors_and_limits(shop: Shop) -> None:
    error_of(await shop.upload(b"sku,price\r\n1,2\r\n"), 422, "csv_invalid_header")
    rows = [csv_row(sku=f"DEMO-{index}", slug=f"demo-{index}") for index in range(2001)]
    error_of(await shop.upload(to_csv(rows)), 422, "csv_too_many_rows")
    error_of(await shop.upload(b"x" * (1024 * 1024 + 1)), 413, "payload_too_large")
    assert await shop.products() == []


async def test_concurrent_imports_of_the_same_new_sku(shop: Shop) -> None:
    raw = to_csv([csv_row()])
    responses = await asyncio.gather(*(shop.upload(raw) for _ in range(3)))
    assert any(response.status_code == 200 for response in responses)
    for response in responses:
        if response.status_code != 200:
            # The loser hits the unique index on sku (or on the derived slug) and writes nothing.
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] in {"sku_taken", "slug_taken"}
    async with shop.factory() as session:
        count = (
            await session.execute(
                select(func.count()).select_from(Product).where(Product.sku == "DEMO-NEW")
            )
        ).scalar_one()
    assert count == 1
    creates = [row for row in await audit_rows(shop.factory) if row.action == "product.create"]
    assert len(creates) == 1
