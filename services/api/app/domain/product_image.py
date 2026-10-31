"""Product image upload rules (ADR 0011): what may be stored, under which key, how it is checked.

Pure functions, no I/O. The storage adapter (``app/storage/images.py``) applies them; nothing is
uploaded until R2 is enabled for an environment.

- **Types**: JPEG, PNG and WebP only, decided by the file's magic bytes. The client's
  ``Content-Type`` and filename are never trusted (an ``.jpg`` holding HTML or SVG is refused, and
  SVG is never accepted: it can carry script).
- **Size**: 1 byte to 5 MiB, and at most 6000 px on either side (checked by the image pipeline
  that will resize; here only the byte size).
- **Key**: ``products/<product uuid>/<sha256 hex>.<ext>``. Content-addressed, so an object is
  immutable (served with a one-year cache), re-uploading the same file is idempotent, and no
  user-controlled text ever becomes part of a key.
- **Checksum**: SHA-256 of the bytes, computed on the server and sent to R2 as the object's
  ``x-amz-checksum-sha256`` so storage rejects a corrupted upload.
- **Filename**: the original name is kept only as sanitised metadata (for the admin's own
  reference), never in the key or a URL.
"""

import base64
import hashlib
import re
import unicodedata
import uuid
from dataclasses import dataclass
from typing import Final, Literal

ImageType = Literal["image/jpeg", "image/png", "image/webp"]

MAX_IMAGE_BYTES: Final = 5 * 1024 * 1024
MAX_FILENAME_LENGTH: Final = 100
EXTENSIONS: Final[dict[ImageType, str]] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
# Content-addressed objects never change, so caches may keep them for a year.
IMMUTABLE_CACHE_CONTROL: Final = "public, max-age=31536000, immutable"

KEY_PATTERN: Final = re.compile(r"^products/[0-9a-f-]{36}/[0-9a-f]{64}\.(jpg|png|webp)$")


class ImageRejectedError(ValueError):
    """The upload is not an acceptable product image. ``code`` is stable for the API."""

    def __init__(self, code: Literal["empty", "too_large", "unsupported_type"]) -> None:
        super().__init__(code)
        self.code = code


def sniff_image_type(data: bytes) -> ImageType | None:
    """The image type from the leading magic bytes, or ``None``."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def safe_filename(name: str | None) -> str | None:
    """A display-only version of the uploaded filename: no path, no control or format
    characters, NFC-normalised, at most 100 characters. ``None`` when nothing usable is left."""
    if not name:
        return None
    base = re.split(r"[\\/]", name)[-1]
    normalized = unicodedata.normalize("NFC", base)
    cleaned = "".join(
        ch for ch in normalized if unicodedata.category(ch)[0] not in ("C", "Z") or ch == " "
    ).strip(" .")
    return cleaned[:MAX_FILENAME_LENGTH] or None


@dataclass(frozen=True, slots=True)
class PreparedImage:
    key: str
    content_type: ImageType
    size: int
    sha256_hex: str
    filename: str | None

    @property
    def sha256_base64(self) -> str:
        """The checksum in the encoding R2/S3 expect for ``x-amz-checksum-sha256``."""
        return base64.b64encode(bytes.fromhex(self.sha256_hex)).decode("ascii")


def prepare_product_image(
    product_id: uuid.UUID, data: bytes, *, filename: str | None = None
) -> PreparedImage:
    """Validate ``data`` and derive its storage key. Raises :class:`ImageRejectedError`."""
    if not data:
        raise ImageRejectedError("empty")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageRejectedError("too_large")
    content_type = sniff_image_type(data)
    if content_type is None:
        raise ImageRejectedError("unsupported_type")
    digest = hashlib.sha256(data).hexdigest()
    return PreparedImage(
        key=f"products/{product_id}/{digest}.{EXTENSIONS[content_type]}",
        content_type=content_type,
        size=len(data),
        sha256_hex=digest,
        filename=safe_filename(filename),
    )


def is_product_image_key(key: str) -> bool:
    return KEY_PATTERN.fullmatch(key) is not None


def public_image_url(cdn_base_url: str, key: str) -> str:
    """``https://<image CDN host>/<key>``: what is stored in ``products.image_url``.

    The result is an ordinary public ``https`` URL, so the existing ``image_url`` validation and
    the storefront's rendering keep working unchanged for both pasted URLs and R2 objects.
    """
    if not is_product_image_key(key):
        raise ValueError("not a product image key")
    return f"{cdn_base_url.rstrip('/')}/{key}"
