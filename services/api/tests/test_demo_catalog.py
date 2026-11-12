"""The operator-run demo catalog (``app.ops.demo_catalog``): the production subset of the dataset,
the confirm phrase, URL handling that never prints the URL, and (against a real database,
``integration``) the empty-catalog refusal, idempotency and removal that only touches demo rows."""

import io
import re
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from app.models.audit import AuditLog
from app.models.cart import Cart, CartItem
from app.models.catalog import Category, Product
from app.models.enums import PaymentMethod
from app.models.order import Order, OrderItem
from app.ops import demo_catalog
from app.ops.demo_catalog import (
    IMPORT_PHRASE,
    REMOVE_PHRASE,
    DemoCatalogError,
    demo_catalog_status,
    demo_database_url,
    import_demo_catalog,
    remove_demo_catalog,
    run,
)
from app.ops.demo_dataset import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    SYNTHETIC_BRANDS,
    production_categories,
    production_products,
)
from tests.db_data import SessionFactory, add_category, add_product, add_user

pytest_plugins = ["tests.db_fixtures"]

API_ROOT = Path(__file__).resolve().parent.parent
# Recognisable fake URL parts that must never show up in any output.
SECRET_USER = "leaky_demo_user"
SECRET_PASSWORD = "not-a-real-password-7f3a9c"
SECRET_HOST = "db-secret-host.example.invalid"
IMPORTS_DEMO_CATALOG = re.compile(
    r"^\s*(from\s+app\.ops\.demo_catalog\s+import|import\s+app\.ops\.demo_catalog"
    r"|from\s+app\.ops\s+import\s+.*\bdemo_catalog\b)",
    re.MULTILINE,
)


class Output:
    def __init__(self) -> None:
        self.out = io.StringIO()
        self.err = io.StringIO()

    @property
    def text(self) -> str:
        return self.out.getvalue() + self.err.getvalue()


def _refuse_to_connect(url: str) -> AsyncEngine:
    raise AssertionError("must not connect")


# --- dataset --------------------------------------------------------------------------------------


def test_production_subset_is_a_coherent_storefront_catalog() -> None:
    categories = production_categories()
    products = production_products()
    top_level = [c for c in categories if c.parent_slug is None]
    subcategories = [c for c in categories if c.parent_slug is not None]
    assert len(top_level) >= 8
    assert len(subcategories) >= 3
    assert 45 <= len(products) <= 60
    assert all(c.is_active for c in categories)
    slugs = {c.slug for c in categories}
    assert all(c.parent_slug is None or c.parent_slug in slugs for c in categories)
    assert all(p.category_slug in slugs for p in products)
    # Every category shows something (directly or through a subcategory).
    used = {p.category_slug for p in products if p.is_active}
    for category in categories:
        children = {c.slug for c in categories if c.parent_slug == category.slug}
        assert used & (children | {category.slug}), category.slug


def test_production_subset_leaves_out_the_dev_only_fixtures() -> None:
    assert not any(row.dev_only for row in production_categories())
    assert not any(row.dev_only for row in production_products())
    # ...which the dev seed still has (one dataset, not two lists).
    assert any(row.dev_only for row in DEMO_CATEGORIES)
    assert any(row.dev_only for row in DEMO_PRODUCTS)
    assert set(production_products()) <= set(DEMO_PRODUCTS)


def test_production_subset_is_synthetic_and_has_a_stock_mix() -> None:
    products = production_products()
    for product in products:
        assert re.fullmatch(r"DEMO-\d{4}", product.sku)
        assert product.slug.startswith("demo-")
        assert product.brand is None or product.brand in SYNTHETIC_BRANDS
        assert "http" not in product.description_uz + product.description_ru
        assert "'" not in product.name_uz + product.description_uz  # U+2018/U+2019 only
    assert len({p.brand for p in products if p.brand}) >= 4
    stock = [p.stock_quantity for p in products if p.is_active]
    assert any(q is None for q in stock)  # untracked
    assert sum(q == 0 for q in stock) >= 2  # out of stock
    assert any(q is not None and 1 <= q <= 5 for q in stock)  # low
    assert sum(q is not None and q > 5 for q in stock) >= 20  # in stock
    with_old_price = [p for p in products if p.old_price_uzs is not None]
    assert 3 <= len(with_old_price) < len(products) // 2


def test_nothing_runs_the_import_automatically() -> None:
    """Only the operator command itself references it: no migration, app start-up or seed hook."""
    offenders = [
        path
        for folder in ("app", "alembic")
        for path in (API_ROOT / folder).rglob("*.py")
        if path.name != "demo_catalog.py" and IMPORTS_DEMO_CATALOG.search(path.read_text("utf-8"))
    ]
    assert offenders == []


# --- confirm phrase and URL handling --------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "phrase"),
    [
        ("import", "import demo catalog"),
        ("import", REMOVE_PHRASE),
        ("import", "yes"),
        ("remove", IMPORT_PHRASE),
        ("remove", "REMOVE DEMO CATALOG "),
        ("remove", ""),
    ],
)
async def test_a_wrong_confirm_phrase_is_refused_before_connecting(
    command: str, phrase: str
) -> None:
    output = Output()
    environ = {"DEMO_IMPORT_DATABASE_URL": "postgresql+asyncpg://u:p@localhost/db"}
    code = await run(
        [command, "--confirm", phrase],
        environ,
        engine_factory=_refuse_to_connect,
        out=output.out,
        err=output.err,
    )
    assert code == demo_catalog.EXIT_USAGE
    assert "refused" in output.err.getvalue()


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        f"postgresql://{SECRET_USER}:{SECRET_PASSWORD}@{SECRET_HOST}:5432/db?sslmode=require",
        f"postgresql+asyncpg://{SECRET_USER}:{SECRET_PASSWORD}@{SECRET_HOST}/db",
        f"postgresql+asyncpg://{SECRET_USER}:{SECRET_PASSWORD}@{SECRET_HOST}/db?sslmode=require",
        f"postgresql+asyncpg://{SECRET_USER}:{SECRET_PASSWORD}@{SECRET_HOST}/db?ssl=require",
        f"not a url {SECRET_PASSWORD}",
    ],
)
async def test_invalid_urls_are_refused_without_echoing_them(url: str) -> None:
    output = Output()
    code = await run(
        ["status"],
        {"DEMO_IMPORT_DATABASE_URL": url},
        engine_factory=_refuse_to_connect,
        out=output.out,
        err=output.err,
    )
    assert code == demo_catalog.EXIT_USAGE
    assert "DEMO_IMPORT_DATABASE_URL" in output.err.getvalue()
    for secret in (SECRET_USER, SECRET_PASSWORD, SECRET_HOST):
        assert secret not in output.text


def test_url_rules() -> None:
    with pytest.raises(DemoCatalogError):
        demo_database_url({})
    local = "postgresql+asyncpg://u:p@127.0.0.1:5432/db"
    assert demo_database_url({"DEMO_IMPORT_DATABASE_URL": local}) == local
    remote = f"postgresql+asyncpg://u:p@{SECRET_HOST}/db?ssl=verify-full"
    assert demo_database_url({"DEMO_IMPORT_DATABASE_URL": remote}) == remote


@pytest.mark.parametrize("argv", [["status"], ["import"], ["remove", "--confirm", REMOVE_PHRASE]])
async def test_connection_errors_never_print_the_url(argv: list[str]) -> None:
    """Driver errors mention host, port or user; the command reports the exception type only."""
    output = Output()
    url = f"postgresql+asyncpg://{SECRET_USER}:{SECRET_PASSWORD}@127.0.0.1:1/secret_db_name"
    code = await run(argv, {"DEMO_IMPORT_DATABASE_URL": url}, out=output.out, err=output.err)
    assert code == demo_catalog.EXIT_FAILED
    assert "failed (" in output.err.getvalue()
    for secret in (SECRET_USER, SECRET_PASSWORD, "127.0.0.1", ":1", "secret_db_name"):
        assert secret not in output.text


# --- against a real database ----------------------------------------------------------------------


async def _snapshot(factory: SessionFactory) -> dict[str, list[tuple[Any, ...]]]:
    async with factory() as session:
        return {
            table.name: sorted(  # type: ignore[attr-defined]
                (tuple(row) for row in (await session.execute(select(table))).all()), key=repr
            )
            for table in (Category.__table__, Product.__table__)
        }


async def _count(factory: SessionFactory, model: type[Any], *where: Any) -> int:
    async with factory() as session:
        statement = select(func.count()).select_from(model).where(*where)
        return int((await session.execute(statement)).scalar_one())


async def _product(factory: SessionFactory, slug: str) -> Product | None:
    async with factory() as session:
        return (
            await session.execute(select(Product).where(Product.slug == slug))
        ).scalar_one_or_none()


async def _category(factory: SessionFactory, slug: str) -> Category | None:
    async with factory() as session:
        return (
            await session.execute(select(Category).where(Category.slug == slug))
        ).scalar_one_or_none()


async def _order_for(factory: SessionFactory, slugs: list[str]) -> uuid.UUID:
    user = await add_user(factory)
    async with factory() as session:
        products = list(
            (await session.execute(select(Product).where(Product.slug.in_(slugs)))).scalars()
        )
        subtotal = sum(product.price_uzs for product in products)
        order = Order(
            number=f"T-{uuid.uuid4().hex[:10]}",
            user_id=user.id,
            subtotal_uzs=subtotal,
            total_uzs=subtotal,
            item_count=len(products),
            payment_method=PaymentMethod.CASH_ON_DELIVERY,
            recipient_name="Demo Mijoz",
            recipient_phone="+998001234567",
            address_snapshot={"lat": 41.311081, "lon": 69.240562, "street": "Demo", "house": "1"},
            idempotency_key=uuid.uuid4().hex,
            idempotency_request_hash="0" * 64,
        )
        session.add(order)
        await session.flush()
        session.add_all(
            OrderItem(
                order_id=order.id,
                product_id=product.id,
                sku=product.sku,
                name_uz=product.name_uz,
                name_ru=product.name_ru,
                unit=product.unit,
                unit_price_uzs=product.price_uzs,
                quantity=1,
                line_total_uzs=product.price_uzs,
            )
            for product in products
        )
        await session.commit()
        return order.id


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_dry_run_writes_nothing_and_import_is_idempotent(
    session_factory: SessionFactory,
) -> None:
    empty = await _snapshot(session_factory)
    dry = await import_demo_catalog(session_factory, apply=False)
    assert not dry.applied
    assert dry.products_created == len(production_products())
    assert await _snapshot(session_factory) == empty
    assert await _count(session_factory, AuditLog) == 0

    first = await import_demo_catalog(session_factory, apply=True)
    assert first.categories_created == len(production_categories())
    assert first.products_created == len(production_products())
    after_first = await _snapshot(session_factory)
    assert await _count(session_factory, Product, Product.image_url.is_not(None)) == 0
    assert await _count(session_factory, Category, Category.parent_id.is_not(None)) >= 3
    # The dev-only fixtures stay out of production.
    assert await _category(session_factory, "demo-arxiv") is None

    second = await import_demo_catalog(session_factory, apply=True)
    assert second.changed == 0
    assert await _snapshot(session_factory) == after_first
    # One audit row for the import that changed something, none for the no-op.
    assert await _count(session_factory, AuditLog) == 1

    status = await demo_catalog_status(session_factory)
    assert status.demo_products == len(production_products())
    assert status.demo_categories == len(production_categories())
    assert (status.other_categories, status.other_products) == (0, 0)


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_import_keeps_admin_edits_to_demo_rows(session_factory: SessionFactory) -> None:
    await import_demo_catalog(session_factory, apply=True)
    async with session_factory() as session:
        product = (
            await session.execute(select(Product).where(Product.slug == "demo-olma"))
        ).scalar_one()
        product.price_uzs = 16_500
        await session.commit()
    again = await import_demo_catalog(session_factory, apply=True)
    assert again.changed == 0
    edited = await _product(session_factory, "demo-olma")
    assert edited is not None
    assert edited.price_uzs == 16_500


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
@pytest.mark.parametrize("real_row", ["category", "product_with_real_sku"])
async def test_import_refuses_a_catalog_with_real_data(
    session_factory: SessionFactory, real_row: str
) -> None:
    if real_row == "category":
        await add_category(session_factory, "mevalar")
    else:
        # Demo-looking slug but a real SKU: not demo, so the catalog is not empty.
        category = await add_category(session_factory, "demo-own")
        await add_product(session_factory, category, "demo-own-apple", sku="APPLE-1")
    before = await _snapshot(session_factory)
    for apply in (False, True):
        with pytest.raises(DemoCatalogError, match="real data"):
            await import_demo_catalog(session_factory, apply=apply)
    assert await _snapshot(session_factory) == before
    assert await _count(session_factory, AuditLog) == 0


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_remove_only_touches_demo_rows_and_keeps_order_history(
    session_factory: SessionFactory,
) -> None:
    await import_demo_catalog(session_factory, apply=True)
    # Real data added after the import: a real category/product, and a real product that an
    # admin put into a demo subcategory.
    real_category = await add_category(session_factory, "real-fruits", name_uz="Mevalar")
    real_product = await add_product(session_factory, real_category, "real-apple", sku="R-0001")
    demo_fruits = await _category(session_factory, "demo-mevalar")
    assert demo_fruits is not None
    await add_product(session_factory, demo_fruits, "real-pear", sku="R-0002")
    # An order references two demo products.
    order_id = await _order_for(session_factory, ["demo-olma", "demo-sabzi"])
    # A cart line on a demo product that will be deleted.
    user = await add_user(session_factory)
    banana = await _product(session_factory, "demo-banan")
    assert banana is not None
    async with session_factory() as session:
        cart = Cart(user_id=user.id)
        session.add(cart)
        await session.flush()
        session.add(CartItem(cart_id=cart.id, product_id=banana.id, quantity=1))
        await session.commit()
    before = await _snapshot(session_factory)
    dry = await remove_demo_catalog(session_factory, apply=False)
    assert not dry.applied
    assert dry.products_archived == 2
    assert await _snapshot(session_factory) == before

    report = await remove_demo_catalog(session_factory, apply=True)
    assert report.products_archived == 2
    assert report.products_deleted == len(production_products()) - 2

    # Products referenced by orders are archived, not deleted; the order still points at them.
    for slug in ("demo-olma", "demo-sabzi"):
        product = await _product(session_factory, slug)
        assert product is not None
        assert (product.is_active, product.archived_at is not None) == (False, True)
    async with session_factory() as session:
        linked = (
            await session.execute(
                select(func.count())
                .select_from(OrderItem)
                .where(OrderItem.order_id == order_id, OrderItem.product_id.is_not(None))
            )
        ).scalar_one()
        assert linked == 2
    assert await _product(session_factory, "demo-banan") is None
    assert await _count(session_factory, CartItem) == 0

    # Categories: the demo one holding a real product stays (with its demo parent), active;
    # the one holding only an archived demo product is deactivated; the rest are gone.
    fruits = await _category(session_factory, "demo-mevalar")
    parent = await _category(session_factory, "demo-mevalar-sabzavotlar")
    vegetables = await _category(session_factory, "demo-sabzavotlar")
    assert fruits is not None
    assert fruits.is_active
    assert parent is not None
    assert parent.is_active
    assert vegetables is not None
    assert not vegetables.is_active
    assert await _category(session_factory, "demo-non") is None
    assert report.categories_kept == 2
    assert report.categories_deactivated == 1

    # Real rows are exactly as before.
    after = await _snapshot(session_factory)
    for table in ("categories", "products"):
        real_before = {row for row in before[table] if not _is_demo(table, row)}
        real_after = {row for row in after[table] if not _is_demo(table, row)}
        assert real_after == real_before, table
    kept_real = await _product(session_factory, "real-apple")
    assert kept_real is not None
    assert kept_real.id == real_product.id

    # A second removal has nothing left to do.
    again = await remove_demo_catalog(session_factory, apply=True)
    assert again.changed == 0


def _is_demo(table: str, row: tuple[Any, ...]) -> bool:
    text = " ".join(str(value) for value in row)
    if table == "products":
        return "demo-" in text and "DEMO-" in text
    return " demo-" in f" {text}"


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_command_line_end_to_end(
    session_factory: SessionFactory, engine: AsyncEngine
) -> None:
    environ = {"DEMO_IMPORT_DATABASE_URL": "postgresql+asyncpg://unused@localhost/unused"}

    async def invoke(*argv: str) -> tuple[int, str]:
        output = Output()
        code = await run(
            list(argv), environ, engine_factory=lambda _url: engine, out=output.out, err=output.err
        )
        return code, output.text

    code, text = await invoke("import")
    assert code == 0
    assert "DRY RUN" in text
    assert IMPORT_PHRASE in text
    assert await _count(session_factory, Product) == 0

    code, text = await invoke("import", "--confirm", IMPORT_PHRASE)
    assert code == 0
    assert f"products created: {len(production_products())}" in text

    code, text = await invoke("status")
    assert code == 0
    assert f"demo products: {len(production_products())}" in text
    assert "import allowed: yes" in text

    await add_category(session_factory, "real-category")
    code, text = await invoke("import", "--confirm", IMPORT_PHRASE)
    assert code == demo_catalog.EXIT_REFUSED
    assert "real data" in text

    code, text = await invoke("remove", "--confirm", REMOVE_PHRASE)
    assert code == 0
    assert f"products deleted: {len(production_products())}" in text
    assert await _count(session_factory, Product) == 0
    assert await _count(session_factory, Category) == 1
