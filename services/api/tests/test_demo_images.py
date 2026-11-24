"""Demo photos (``app.ops.demo_images``) and the operator-run ``images`` backfill of
``app.ops.demo_catalog``: every production demo row has a photo file with a licence record, base
URLs are validated before any connection, and (against a real database, ``integration``) the
backfill only fills empty image URLs of demo rows."""

import io
import re
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from app.domain.image_url import validate_image_url
from app.models.audit import AuditLog
from app.models.catalog import Category, Product
from app.ops import demo_catalog
from app.ops.demo_catalog import (
    IMAGES_PHRASE,
    IMPORT_PHRASE,
    import_demo_catalog,
    run,
    set_demo_images,
)
from app.ops.demo_dataset import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    production_categories,
    production_products,
)
from app.ops.demo_images import (
    DEMO_CATEGORY_IMAGES,
    DEMO_PRODUCT_IMAGES,
    InvalidImageBaseUrlError,
    category_image_url,
    demo_image_url,
    product_image_url,
    validate_image_base_url,
)
from tests.db_data import SessionFactory, add_category, add_product

pytest_plugins = ["tests.db_fixtures"]

REPO_ROOT = Path(__file__).resolve().parents[3]
PUBLIC = REPO_ROOT / "apps" / "web" / "public"
BASE = "https://shop.example.uz"
DB_ENV = {"DEMO_IMPORT_DATABASE_URL": "postgresql+asyncpg://u:p@localhost/db"}
MANIFEST_ROW = re.compile(
    r"^\|\s*`(?P<file>[a-z0-9-]+\.webp)`\s*\|\s*\[[^\]]*\]\((?P<page>[^)]+)\)\s*\|"
)
ALLOWED_PAGES = ("https://unsplash.com/photos/", "https://www.pexels.com/photo/")


def _refuse_to_connect(url: str) -> AsyncEngine:
    raise AssertionError("must not connect")


async def _invoke(*argv: str, environ: dict[str, str] | None = None) -> tuple[int, str]:
    out, err = io.StringIO(), io.StringIO()
    code = await run(
        list(argv),
        environ or DB_ENV,
        engine_factory=_refuse_to_connect,
        out=out,
        err=err,
    )
    return code, out.getvalue() + err.getvalue()


# --- the map --------------------------------------------------------------------------------------


def test_every_production_row_has_a_photo_and_dev_only_rows_keep_the_monogram() -> None:
    assert {p.slug for p in production_products()} == set(DEMO_PRODUCT_IMAGES)
    assert {c.slug for c in production_categories()} == set(DEMO_CATEGORY_IMAGES)
    dev_only = [p.slug for p in DEMO_PRODUCTS if p.dev_only]
    dev_only += [c.slug for c in DEMO_CATEGORIES if c.dev_only]
    assert dev_only
    assert not set(dev_only) & (set(DEMO_PRODUCT_IMAGES) | set(DEMO_CATEGORY_IMAGES))


def test_paths_are_distinct_storefront_assets() -> None:
    for images, folder in ((DEMO_PRODUCT_IMAGES, "products"), (DEMO_CATEGORY_IMAGES, "categories")):
        assert len(set(images.values())) == len(images)
        for path in images.values():
            assert re.fullmatch(rf"/{folder}/[a-z0-9-]+\.webp", path), path


@pytest.mark.skipif(not PUBLIC.is_dir(), reason="the storefront is not checked out next to the API")
@pytest.mark.parametrize("folder", ["products", "categories"])
def test_every_photo_has_both_sizes_and_a_licence_record(folder: str) -> None:
    images = DEMO_PRODUCT_IMAGES if folder == "products" else DEMO_CATEGORY_IMAGES
    manifest = (PUBLIC / folder / "SOURCES.md").read_text("utf-8")
    rows = {
        match["file"]: match["page"]
        for line in manifest.splitlines()
        if (match := MANIFEST_ROW.match(line))
    }
    for path in images.values():
        name = Path(path).name
        for file in (PUBLIC / folder / name, PUBLIC / folder / name.replace(".webp", "-400.webp")):
            data = file.read_bytes()
            assert data[:4] == b"RIFF", file
            assert data[8:12] == b"WEBP", file
            # Re-encoded without metadata: no EXIF/XMP chunks.
            assert b"EXIF" not in data[:4096], file
            assert b"XMP " not in data[:4096], file
            # A cut-out: extended WebP with an alpha channel, so the storefront's CSS tile shows
            # through in light and dark mode (VP8X header, alpha flag 0x10).
            assert data[12:16] == b"VP8X", file
            assert data[20] & 0x10, file
        assert rows.get(name, "").startswith(ALLOWED_PAGES), name
    assert set(rows) == {Path(path).name for path in images.values()}


def test_urls_are_paths_without_a_base_and_valid_absolute_urls_with_one() -> None:
    assert product_image_url("demo-banan", None) == "/products/banan.webp"
    assert category_image_url("demo-sut", None) == "/categories/sut.webp"
    assert product_image_url("demo-arxiv-mahsulot", BASE) is None
    assert product_image_url("real-product", BASE) is None
    assert demo_image_url(None, BASE) is None
    for slug in DEMO_PRODUCT_IMAGES:
        url = product_image_url(slug, BASE)
        assert url is not None
        assert validate_image_url(url) == url


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(BASE, BASE), (f"{BASE}/", BASE), (f"  {BASE} ", BASE), ("https://a.b.example", None)],
)
def test_base_url_accepts_a_public_https_origin(raw: str, expected: str | None) -> None:
    assert validate_image_base_url(raw) == (expected or raw)


@pytest.mark.parametrize(
    "raw",
    [
        "http://shop.example.uz",
        "https://localhost",
        "https://127.0.0.1",
        "https://shop.example.uz:8443",
        "https://user:pw@shop.example.uz",
        "https://shop.example.uz/store",
        "https://shop.example.uz?x=1",
        "shop.example.uz",
    ],
)
def test_base_url_refuses_anything_but_a_public_https_origin(raw: str) -> None:
    with pytest.raises(InvalidImageBaseUrlError) as caught:
        validate_image_base_url(raw)
    assert "pw" not in str(caught.value)


# --- command line, before any connection ----------------------------------------------------------


async def test_a_bad_base_url_is_refused_before_connecting() -> None:
    code, text = await _invoke("images", "--image-base-url", "http://shop.example.uz")
    assert code == demo_catalog.EXIT_USAGE
    assert "https" in text

    code, text = await _invoke("import", "--image-base-url", "https://shop.example.uz/sub")
    assert code == demo_catalog.EXIT_USAGE


@pytest.mark.parametrize("phrase", ["set demo images", IMPORT_PHRASE, "SET DEMO IMAGES ", ""])
async def test_images_refuses_a_wrong_confirm_phrase_before_connecting(phrase: str) -> None:
    code, text = await _invoke("images", "--image-base-url", BASE, "--confirm", phrase)
    assert code == demo_catalog.EXIT_USAGE
    assert "refused" in text


async def test_the_base_url_is_optional_and_may_come_from_the_environment() -> None:
    """Without a base (storefront paths) or with a valid one from ``DEMO_IMAGE_BASE_URL``, the
    command goes on to connect."""
    for environ in (DB_ENV, {**DB_ENV, "DEMO_IMAGE_BASE_URL": BASE}):
        with pytest.raises(AssertionError, match="must not connect"):
            await _invoke("images", environ=environ)
    code, _ = await _invoke("images", environ={**DB_ENV, "DEMO_IMAGE_BASE_URL": "http://x.uz"})
    assert code == demo_catalog.EXIT_USAGE


# --- against a real database ----------------------------------------------------------------------


async def _images(factory: SessionFactory) -> dict[str, str | None]:
    async with factory() as session:
        products = (await session.execute(select(Product.slug, Product.image_url))).all()
        categories = (await session.execute(select(Category.slug, Category.image_url))).all()
    # Keyed "product:<slug>" / "category:<slug>": "demo-sut" is both.
    return {f"product:{slug}": url for slug, url in products} | {
        f"category:{slug}": url for slug, url in categories
    }


async def _clear_images(factory: SessionFactory) -> None:
    """A catalog imported before the photos existed: no image URLs at all."""
    async with factory() as session:
        await session.execute(update(Product).values(image_url=None))
        await session.execute(update(Category).values(image_url=None))
        await session.commit()


async def _count(factory: SessionFactory, model: type[Any], *where: Any) -> int:
    async with factory() as session:
        statement = select(func.count()).select_from(model).where(*where)
        return int((await session.execute(statement)).scalar_one())


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_backfill_fills_only_empty_demo_images(session_factory: SessionFactory) -> None:
    await import_demo_catalog(session_factory, apply=True)
    await _clear_images(session_factory)
    audit_before = await _count(session_factory, AuditLog)

    # An admin's own photo, an empty string, and a real product without a photo.
    async with session_factory() as session:
        await session.execute(
            update(Product)
            .where(Product.slug == "demo-banan")
            .values(image_url="https://cdn.example.uz/own.webp")
        )
        await session.execute(
            update(Category).where(Category.slug == "demo-non").values(image_url=" ")
        )
        await session.commit()
    real_category = await add_category(session_factory, "real-category")
    await add_product(session_factory, real_category, "real-product")

    dry = await set_demo_images(session_factory, image_base_url=BASE, apply=False)
    assert not dry.applied
    assert dry.products_updated == len(production_products()) - 1
    assert dry.products_kept == 1
    assert dry.categories_updated == len(production_categories())
    assert await _count(session_factory, Product, Product.image_url.is_not(None)) == 1
    assert await _count(session_factory, AuditLog) == audit_before

    applied = await set_demo_images(session_factory, image_base_url=BASE, apply=True)
    assert applied.changed == dry.changed
    images = await _images(session_factory)
    assert images["product:demo-banan"] == "https://cdn.example.uz/own.webp"
    assert images["product:demo-olma"] == f"{BASE}/products/olma.webp"
    assert images["product:demo-sut"] == f"{BASE}/products/sut.webp"
    assert images["category:demo-sut"] == f"{BASE}/categories/sut.webp"
    assert images["category:demo-non"] == f"{BASE}/categories/non.webp"
    assert images["product:real-product"] is None
    assert images["category:real-category"] is None
    assert await _count(session_factory, AuditLog) == audit_before + 1

    again = await set_demo_images(session_factory, image_base_url=BASE, apply=True)
    assert again.changed == 0
    assert await _images(session_factory) == images
    assert await _count(session_factory, AuditLog) == audit_before + 1


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_import_sets_the_photos_as_storefront_paths(
    session_factory: SessionFactory,
) -> None:
    report = await import_demo_catalog(session_factory, apply=True)
    assert report.image_base_url is None
    images = await _images(session_factory)
    assert images["product:demo-banan"] == "/products/banan.webp"
    assert images["category:demo-sut"] == "/categories/sut.webp"
    assert sum(url is not None for url in images.values()) == len(DEMO_PRODUCT_IMAGES) + len(
        DEMO_CATEGORY_IMAGES
    )
    assert (await set_demo_images(session_factory, apply=True)).changed == 0


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_import_with_a_base_url_stores_absolute_urls(session_factory: SessionFactory) -> None:
    report = await import_demo_catalog(session_factory, apply=True, image_base_url=BASE)
    assert report.image_base_url == BASE
    images = await _images(session_factory)
    expected = {f"product:{slug}": path for slug, path in DEMO_PRODUCT_IMAGES.items()} | {
        f"category:{slug}": path for slug, path in DEMO_CATEGORY_IMAGES.items()
    }
    assert {key: images[key] for key in expected} == {
        key: f"{BASE}{path}" for key, path in expected.items()
    }
    assert (await set_demo_images(session_factory, image_base_url=BASE, apply=True)).changed == 0


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_images_command_end_to_end(
    session_factory: SessionFactory, engine: AsyncEngine
) -> None:
    async def invoke(*argv: str) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        code = await run(list(argv), DB_ENV, engine_factory=lambda _url: engine, out=out, err=err)
        return code, out.getvalue() + err.getvalue()

    code, text = await invoke("import", "--confirm", IMPORT_PHRASE)
    assert code == 0
    assert "image URLs: demo photos as storefront paths" in text
    await _clear_images(session_factory)

    code, text = await invoke("images")
    assert code == 0
    assert "DRY RUN" in text
    assert IMAGES_PHRASE in text
    assert await _count(session_factory, Product, Product.image_url.is_not(None)) == 0

    code, text = await invoke("images", "--confirm", IMAGES_PHRASE)
    assert code == 0
    assert f"products updated: {len(production_products())}" in text
    assert "postgresql" not in text
    assert await _count(session_factory, Product, Product.image_url.is_(None)) == 0
    assert (await _images(session_factory))["product:demo-olma"] == "/products/olma.webp"
