"""The dev seed: environment guard and the shape of its (synthetic) data. No database needed."""

import re

import pytest

from app.dev.seed import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    SeedRefusedError,
    ensure_safe_environment,
)


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_allowed_environments(app_env: str) -> None:
    ensure_safe_environment(app_env)


@pytest.mark.parametrize("app_env", ["production", "staging", "", "prod", "Development"])
def test_refuses_everything_else(app_env: str) -> None:
    with pytest.raises(SeedRefusedError):
        ensure_safe_environment(app_env)


def test_data_is_obviously_synthetic() -> None:
    for product in DEMO_PRODUCTS:
        assert re.fullmatch(r"DEMO-\d{4}", product.sku)
        assert product.slug.startswith("demo-")
        assert product.name_uz.startswith("Demo ")
        assert product.name_ru.startswith("Демо ")
        assert product.price_uzs % 1000 == 0
    for category in DEMO_CATEGORIES:
        assert category.slug.startswith("demo-")
        assert category.name_uz.startswith("Demo ")
        assert category.name_ru.startswith("Демо ")


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


def test_covers_the_edge_cases_the_shop_must_handle() -> None:
    assert any(product.old_price_uzs for product in DEMO_PRODUCTS)
    assert any(product.stock_quantity is None for product in DEMO_PRODUCTS)
    assert any(product.stock_quantity == 0 for product in DEMO_PRODUCTS)
    assert any(not product.is_active for product in DEMO_PRODUCTS)
    assert any(not category.is_active for category in DEMO_CATEGORIES)
    for product in DEMO_PRODUCTS:
        assert product.old_price_uzs is None or product.old_price_uzs > product.price_uzs
        assert product.stock_quantity is None or product.stock_quantity >= 0
