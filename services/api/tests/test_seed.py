"""The dev seed: environment guard and the shape of its (synthetic) data, plus (against a real
database, ``integration``) that a re-run is idempotent."""

# Uzbek Latin is written with U+2018/U+2019 apostrophes (as in the storefront); ruff flags them.
# ruff: noqa: RUF001

import re

import pytest
from sqlalchemy import func, select, update

from app.dev.seed import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    SYNTHETIC_BRANDS,
    SeedProduct,
    SeedRefusedError,
    ensure_safe_environment,
    seed,
)
from app.models.catalog import Product
from app.models.enums import Unit
from tests.db_data import SessionFactory

pytest_plugins = ["tests.db_fixtures"]  # the session_factory fixture (integration test only)


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_allowed_environments(app_env: str) -> None:
    ensure_safe_environment(app_env)


@pytest.mark.parametrize("app_env", ["production", "staging", "", "prod", "Development"])
def test_refuses_everything_else(app_env: str) -> None:
    with pytest.raises(SeedRefusedError):
        ensure_safe_environment(app_env)


BANNED_BRAND_WORDS = (
    "nestl",
    "coca",
    "pepsi",
    "lactel",
    "musaffo",
    "hydrolife",
    "bonaqua",
    "lipton",
    "ahmad",
    "makfa",
    "fanta",
    "sprite",
)


def _active_products() -> list[SeedProduct]:
    return [product for product in DEMO_PRODUCTS if product.is_active]


def _visible_products() -> list[SeedProduct]:
    """Active products whose whole category chain is active (what the storefront lists)."""
    inactive = {category.slug for category in DEMO_CATEGORIES if not category.is_active}
    parents = {category.slug: category.parent_slug for category in DEMO_CATEGORIES}

    def chain_active(slug: str | None) -> bool:
        while slug is not None:
            if slug in inactive:
                return False
            slug = parents[slug]
        return True

    return [p for p in _active_products() if chain_active(p.category_slug)]


def test_data_is_obviously_synthetic() -> None:
    for product in DEMO_PRODUCTS:
        assert re.fullmatch(r"DEMO-\d{4}", product.sku)
        assert product.slug.startswith("demo-")
        assert product.brand is None or product.brand in SYNTHETIC_BRANDS
        assert product.price_uzs % 500 == 0
    for category in DEMO_CATEGORIES:
        assert category.slug.startswith("demo-")
    for brand in SYNTHETIC_BRANDS:
        assert not any(word in brand.lower() for word in BANNED_BRAND_WORDS)
    # Names read like a real store: no "Demo"/"Демо" label (the markers are SKUs/slugs/brands).
    for name in (
        *(product.name_uz for product in DEMO_PRODUCTS),
        *(product.name_ru for product in DEMO_PRODUCTS),
        *(category.name_uz for category in DEMO_CATEGORIES),
        *(category.name_ru for category in DEMO_CATEGORIES),
    ):
        assert not name.startswith(("Demo ", "Демо "))


def test_catalog_is_large_enough_for_a_realistic_demo() -> None:
    top_level = [c for c in DEMO_CATEGORIES if c.parent_slug is None and c.is_active]
    assert len(top_level) >= 8
    assert len(_visible_products()) >= 36
    # Every active top-level category has products (directly or through a child category).
    for category in top_level:
        children = {c.slug for c in DEMO_CATEGORIES if c.parent_slug == category.slug}
        assert any(
            product.category_slug in children | {category.slug} for product in _visible_products()
        ), category.slug


def test_names_and_descriptions_are_filled_in_both_languages() -> None:
    for category in DEMO_CATEGORIES:
        assert category.name_uz.strip()
        assert category.name_ru.strip()
    for product in DEMO_PRODUCTS:
        assert product.name_uz.strip()
        assert product.name_ru.strip()
        assert product.description_uz.strip()
        assert product.description_ru.strip()
        assert product.unit in set(Unit)
        # Uzbek is Latin, Russian is Cyrillic.
        assert not re.search(r"[А-Яа-яЁё]", product.name_uz)
        assert re.search(r"[А-Яа-яЁё]", product.name_ru)


def test_keys_are_unique_and_references_resolve() -> None:
    category_slugs = [category.slug for category in DEMO_CATEGORIES]
    assert len(set(category_slugs)) == len(category_slugs)
    assert len({product.sku for product in DEMO_PRODUCTS}) == len(DEMO_PRODUCTS)
    assert len({product.slug for product in DEMO_PRODUCTS}) == len(DEMO_PRODUCTS)
    seen: set[str] = set()
    for category in DEMO_CATEGORIES:  # parents are declared before children
        assert category.parent_slug is None or category.parent_slug in seen
        seen.add(category.slug)
    assert all(product.category_slug in seen for product in DEMO_PRODUCTS)


def test_prices_are_plausible() -> None:
    for product in DEMO_PRODUCTS:
        assert 2_000 <= product.price_uzs <= 150_000
        if product.old_price_uzs is not None:
            assert product.old_price_uzs % 500 == 0
            assert product.old_price_uzs > product.price_uzs
            assert product.old_price_uzs <= product.price_uzs * 1.25


def test_covers_the_edge_cases_the_shop_must_handle() -> None:
    active = _visible_products()
    assert any(product.old_price_uzs for product in active)
    assert any(product.stock_quantity is None for product in active)
    assert sum(product.stock_quantity == 0 for product in active) >= 2
    assert any(
        product.stock_quantity is not None and 1 <= product.stock_quantity <= 3
        for product in active
    )
    assert any((product.stock_quantity or 0) >= 100 for product in active)
    assert any(not product.is_active for product in DEMO_PRODUCTS)
    assert any(not category.is_active for category in DEMO_CATEGORIES)
    # A product under an inactive category chain stays hidden.
    assert len(_visible_products()) == len(_active_products()) - 1
    # One very long (but plausible) name, in both languages.
    assert any(len(p.name_uz) >= 60 and len(p.name_ru) >= 60 for p in active)
    assert all(len(p.name_uz) <= 120 and len(p.name_ru) <= 120 for p in DEMO_PRODUCTS)
    for product in DEMO_PRODUCTS:
        assert product.stock_quantity is None or product.stock_quantity >= 0


def test_products_the_e2e_specs_rely_on_are_unchanged() -> None:
    by_slug = {product.slug: product for product in DEMO_PRODUCTS}
    # The checkout spec buys these.
    assert by_slug["demo-olma"].price_uzs == 15_000
    assert (by_slug["demo-olma"].stock_quantity or 0) >= 10
    assert by_slug["demo-uzum"].price_uzs == 35_000
    assert (by_slug["demo-uzum"].stock_quantity or 0) >= 10
    # admin-catalog spec: lowers the stock by 13 and finds it by SKU.
    assert by_slug["demo-sabzi"].sku == "DEMO-0006"
    assert (by_slug["demo-sabzi"].stock_quantity or 0) >= 20


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_seed_is_idempotent(session_factory: SessionFactory) -> None:
    first = await seed(session_factory)
    assert (first.categories_written, first.products_written) == (
        len(DEMO_CATEGORIES),
        len(DEMO_PRODUCTS),
    )
    again = await seed(session_factory)
    assert (again.categories_written, again.products_written) == (0, 0)
    async with session_factory() as session:
        assert (
            await session.execute(select(func.count()).select_from(Product))
        ).scalar_one() == len(DEMO_PRODUCTS)


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_seed_leaves_archived_demo_products_alone(session_factory: SessionFactory) -> None:
    """An admin archived a demo product (and changed it): a re-run neither reactivates nor
    updates it, and does not trip ``ck_products_archived_is_inactive``."""
    await seed(session_factory)
    target = next(product for product in DEMO_PRODUCTS if product.is_active)
    async with session_factory() as session:
        await session.execute(
            update(Product)
            .where(Product.slug == target.slug)
            .values(is_active=False, archived_at=func.now(), price_uzs=target.price_uzs + 1000)
        )
        await session.commit()
        before = (
            await session.execute(select(Product.__table__).where(Product.slug == target.slug))
        ).one()

    again = await seed(session_factory)
    assert again.products_written == 0
    async with session_factory() as session:
        after = (
            await session.execute(select(Product.__table__).where(Product.slug == target.slug))
        ).one()
        active = (
            await session.execute(
                select(func.count()).select_from(Product).where(Product.is_active.is_(True))
            )
        ).scalar_one()
    assert after == before
    assert (after.is_active, after.archived_at is not None) == (False, True)
    assert active == sum(1 for product in DEMO_PRODUCTS if product.is_active) - 1
