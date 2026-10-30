import json

from app.dev.export_openapi import render_openapi


def test_export_is_deterministic_and_complete() -> None:
    first = render_openapi()
    assert first == render_openapi()
    assert first.endswith("\n")
    document = json.loads(first)
    paths = document["paths"]
    for path in (
        "/api/v1/auth/telegram/init-data",
        "/api/v1/auth/session",
        "/api/v1/categories",
        "/api/v1/products",
        "/api/v1/products/{slug}",
        "/api/v1/cart",
        "/api/v1/cart/items",
    ):
        assert path in paths
    schemas = document["components"]["schemas"]
    for name in ("ErrorEnvelope", "SessionResponse", "ProductPage", "Cart", "CategoryTree"):
        assert name in schemas


def test_export_contains_no_placeholder_secret() -> None:
    assert "openapi-export-placeholder" not in render_openapi()
