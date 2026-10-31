"""Product image rules and the storage test double (ADR 0011)."""

import hashlib
import uuid

import pytest

from app.domain.image_url import validate_image_url
from app.domain.product_image import (
    MAX_IMAGE_BYTES,
    ImageRejectedError,
    is_product_image_key,
    prepare_product_image,
    public_image_url,
    safe_filename,
    sniff_image_type,
)
from app.storage.images import (
    DisabledImageStorage,
    ImageStorage,
    ImageStorageUnavailableError,
    InMemoryImageStorage,
)

PRODUCT = uuid.UUID("0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10")
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 64


@pytest.mark.parametrize(
    ("data", "expected"),
    [(JPEG, "image/jpeg"), (PNG, "image/png"), (WEBP, "image/webp")],
)
def test_sniff_by_magic_bytes(data: bytes, expected: str) -> None:
    assert sniff_image_type(data) == expected


@pytest.mark.parametrize(
    "data",
    [
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        b"<!doctype html><html>",
        b"GIF89a" + b"\x00" * 10,
        b"RIFF\x00\x00\x00\x00WAVE",
        b"%PDF-1.7",
    ],
)
def test_other_content_is_refused_whatever_its_name(data: bytes) -> None:
    with pytest.raises(ImageRejectedError) as excinfo:
        prepare_product_image(PRODUCT, data, filename="photo.jpg")
    assert excinfo.value.code == "unsupported_type"


def test_size_limits() -> None:
    with pytest.raises(ImageRejectedError, match="empty"):
        prepare_product_image(PRODUCT, b"")
    too_big = JPEG + b"\x00" * MAX_IMAGE_BYTES
    with pytest.raises(ImageRejectedError, match="too_large"):
        prepare_product_image(PRODUCT, too_big)
    exact = JPEG + b"\x00" * (MAX_IMAGE_BYTES - len(JPEG))
    assert prepare_product_image(PRODUCT, exact).size == MAX_IMAGE_BYTES


def test_key_is_content_addressed_and_free_of_user_text() -> None:
    prepared = prepare_product_image(PRODUCT, PNG, filename="../../etc/passwd.png")
    digest = hashlib.sha256(PNG).hexdigest()
    assert prepared.key == f"products/{PRODUCT}/{digest}.png"
    assert prepared.sha256_hex == digest
    assert is_product_image_key(prepared.key)
    assert "passwd" not in prepared.key
    # Same bytes, same key: re-uploading is idempotent.
    assert prepare_product_image(PRODUCT, PNG).key == prepared.key


def test_checksum_is_base64_sha256() -> None:
    prepared = prepare_product_image(PRODUCT, WEBP)
    assert prepared.sha256_base64 == (
        __import__("base64").b64encode(hashlib.sha256(WEBP).digest()).decode()
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("photo.jpg", "photo.jpg"),
        ("C:\\Users\\me\\Desktop\\non.jpg", "non.jpg"),
        ("../../etc/passwd", "passwd"),
        ("evil\u202egpj.exe", "evilgpj.exe"),
        ("zero\u200bwidth.png", "zerowidth.png"),
        ("tab\tand\nnewline.png", "tabandnewline.png"),
        ("Нон (2).jpg", "Нон (2).jpg"),
        ("...", None),
        ("", None),
        (None, None),
        ("a" * 150, "a" * 100),
    ],
)
def test_safe_filename(raw: str | None, expected: str | None) -> None:
    assert safe_filename(raw) == expected


@pytest.mark.parametrize(
    "key",
    [
        f"products/{PRODUCT}/{'a' * 64}.gif",
        f"products/{PRODUCT}/{'a' * 63}.jpg",
        f"products/../{'a' * 64}.jpg",
        f"tmp/{PRODUCT}/{'a' * 64}.jpg",
        f"products/{PRODUCT}/{'A' * 64}.jpg",
    ],
)
def test_foreign_keys_are_not_product_image_keys(key: str) -> None:
    assert not is_product_image_key(key)


def test_public_url_passes_the_existing_image_url_validation() -> None:
    prepared = prepare_product_image(PRODUCT, JPEG)
    url = public_image_url("https://images.example.test/", prepared.key)
    assert url == f"https://images.example.test/{prepared.key}"
    assert validate_image_url(url) == url
    with pytest.raises(ValueError, match="not a product image key"):
        public_image_url("https://images.example.test", "products/../x")


async def test_in_memory_storage_contract() -> None:
    storage: ImageStorage = InMemoryImageStorage()
    prepared = prepare_product_image(PRODUCT, PNG, filename="nonvoy.png")
    stored = await storage.put(prepared, PNG)
    assert stored.cache_control == "public, max-age=31536000, immutable"
    assert stored.sha256_hex == prepared.sha256_hex
    assert await storage.exists(prepared.key)
    await storage.delete(prepared.key)
    await storage.delete(prepared.key)  # idempotent
    assert not await storage.exists(prepared.key)


async def test_disabled_storage_fails_closed() -> None:
    storage: ImageStorage = DisabledImageStorage()
    prepared = prepare_product_image(PRODUCT, JPEG)
    with pytest.raises(ImageStorageUnavailableError):
        await storage.put(prepared, JPEG)
    with pytest.raises(ImageStorageUnavailableError):
        await storage.exists(prepared.key)
