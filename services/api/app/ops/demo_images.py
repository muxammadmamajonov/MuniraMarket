"""Real stock photos for the synthetic demo catalog (products and categories).

The photos are static files of the storefront Worker (``apps/web/public/products/<name>.webp`` and
``apps/web/public/categories/<name>.webp``, each with a 400px ``<name>-400.webp`` variant). Every
one is an Unsplash (Unsplash License) or Pexels (Pexels License) photo; page URL, author and
licence are recorded in the ``SOURCES.md`` next to the files. ``test_demo_images`` checks that every
path below has both files and a manifest row.

A row stores an absolute ``https`` URL in production, because the admin API only accepts plain
public ``https`` image URLs (``app.domain.image_url``) and the admin app lives on another origin.
The origin is the storefront's public one, which is only known at deploy time, so it is passed in
(``--image-base-url`` / ``DEMO_IMAGE_BASE_URL``) and never committed. Without a base the local dev
seed stores the path itself (``/products/banan.webp``), which the storefront resolves against its
own origin.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final
from urllib.parse import urlsplit

from app.domain.image_url import InvalidImageUrlError, validate_image_url

IMAGE_BASE_URL_ENV: Final = "DEMO_IMAGE_BASE_URL"


def _paths(folder: str, slugs: tuple[str, ...]) -> Mapping[str, str]:
    return MappingProxyType(
        {slug: f"/{folder}/{slug.removeprefix('demo-')}.webp" for slug in slugs}
    )


# Every production demo product (``production_products()``) has a photo; the dev-only
# ``demo-arxiv-mahsulot`` deliberately has none, so development keeps exercising the monogram.
DEMO_PRODUCT_IMAGES: Final[Mapping[str, str]] = _paths(
    "products",
    (
        "demo-olma",
        "demo-banan",
        "demo-uzum",
        "demo-limon",
        "demo-anor",
        "demo-eski-mahsulot",
        "demo-pomidor",
        "demo-bodring",
        "demo-sabzi",
        "demo-kartoshka",
        "demo-piyoz",
        "demo-bolgar-qalampiri",
        "demo-patir",
        "demo-lavash",
        "demo-qora-non",
        "demo-samsa",
        "demo-sut",
        "demo-qatiq",
        "demo-pishloq",
        "demo-tuxum",
        "demo-saryog",
        "demo-brinza",
        "demo-mol-gosht",
        "demo-qoy-gosht",
        "demo-tovuq",
        "demo-tovuq-filesi",
        "demo-kiyma",
        "demo-guruch",
        "demo-un",
        "demo-makaron",
        "demo-grechka",
        "demo-shakar",
        "demo-kungaboqar-yogi",
        "demo-tuz",
        "demo-zira",
        "demo-ichimlik-suvi",
        "demo-gazli-suv",
        "demo-olma-sharbati",
        "demo-shaftoli-sharbati",
        "demo-anor-sharbati",
        "demo-qora-choy",
        "demo-yashil-choy",
        "demo-qahva",
        "demo-asal",
        "demo-shokolad",
        "demo-kir-kukuni",
        "demo-qogoz-sochiq",
        "demo-tualet-qogozi",
    ),
)

# Every production demo category; the dev-only archive categories have none.
DEMO_CATEGORY_IMAGES: Final[Mapping[str, str]] = _paths(
    "categories",
    (
        "demo-mevalar-sabzavotlar",
        "demo-mevalar",
        "demo-sabzavotlar",
        "demo-non",
        "demo-sut",
        "demo-gosht",
        "demo-bakaleya",
        "demo-yog-ziravor",
        "demo-ichimliklar",
        "demo-sharbatlar",
        "demo-choy-shirinlik",
        "demo-uy-rozgor",
    ),
)


class InvalidImageBaseUrlError(ValueError):
    """The base URL is not a bare public ``https`` origin (message never echoes the value)."""


def validate_image_base_url(raw: str) -> str:
    """Return the origin without a trailing slash, e.g. ``https://shop.example.uz``."""
    base = raw.strip().removesuffix("/")
    try:
        validate_image_url(base + "/products/check.webp")
    except InvalidImageUrlError as exc:
        raise InvalidImageBaseUrlError(f"image base URL {exc}") from None
    parts = urlsplit(base)
    if parts.path or parts.query or parts.fragment:
        raise InvalidImageBaseUrlError("image base URL must be an origin only (no path or query)")
    return base


def demo_image_url(path: str | None, base_url: str | None) -> str | None:
    """The value to store: ``None`` without a photo, the bare path without a base, else the
    absolute URL (``base_url`` must come from ``validate_image_base_url``)."""
    if path is None:
        return None
    return path if base_url is None else base_url + path


def product_image_url(slug: str, base_url: str | None) -> str | None:
    return demo_image_url(DEMO_PRODUCT_IMAGES.get(slug), base_url)


def category_image_url(slug: str, base_url: str | None) -> str | None:
    return demo_image_url(DEMO_CATEGORY_IMAGES.get(slug), base_url)
