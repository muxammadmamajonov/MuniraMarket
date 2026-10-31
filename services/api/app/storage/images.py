"""Product image storage adapter (Cloudflare R2), behind a small interface.

Nothing here talks to a real bucket yet. The production adapter is added when R2 is enabled for
an environment (infra/r2/README.md); until then the API is wired with
:class:`DisabledImageStorage` and tests use :class:`InMemoryImageStorage`.

Rules every implementation follows:

- The **browser never receives bucket credentials**. Uploads go through the Core API (admin role,
  CSRF, rate limit, size cap) which validates with ``app.domain.product_image`` and then writes,
  or, later, through a short-lived pre-signed ``PUT`` the API issues for one exact key, content
  type, length and checksum.
- Objects are **immutable** (content-addressed keys); replacing a product image writes a new key.
- **Deletion is deferred**: an object is deleted only when no product references it and a grace
  period has passed (rollbacks, CDN caches, open admin tabs). A product that is archived keeps
  its image; it is removed only if the product is later purged.
"""

from dataclasses import dataclass, field
from typing import Protocol

from app.domain.product_image import IMMUTABLE_CACHE_CONTROL, PreparedImage, is_product_image_key


class ImageStorageUnavailableError(RuntimeError):
    """Image storage is not enabled (or not reachable) in this environment."""


@dataclass(frozen=True, slots=True)
class StoredObject:
    key: str
    content_type: str
    size: int
    sha256_hex: str
    cache_control: str


class ImageStorage(Protocol):
    async def put(self, image: PreparedImage, data: bytes) -> StoredObject:
        """Store ``data`` under ``image.key``; idempotent for identical content."""
        ...

    async def delete(self, key: str) -> None:
        """Remove ``key``; a missing object is not an error."""
        ...

    async def exists(self, key: str) -> bool: ...


class DisabledImageStorage:
    """The default until R2 is configured: every operation fails closed."""

    async def put(self, image: PreparedImage, data: bytes) -> StoredObject:  # noqa: ARG002
        raise ImageStorageUnavailableError("image storage is not enabled")

    async def delete(self, key: str) -> None:  # noqa: ARG002
        raise ImageStorageUnavailableError("image storage is not enabled")

    async def exists(self, key: str) -> bool:  # noqa: ARG002
        raise ImageStorageUnavailableError("image storage is not enabled")


@dataclass
class InMemoryImageStorage:
    """Test double with the same contract and checks as the real adapter will have."""

    objects: dict[str, tuple[StoredObject, bytes]] = field(default_factory=dict)
    deleted: list[str] = field(default_factory=list)

    async def put(self, image: PreparedImage, data: bytes) -> StoredObject:
        if not is_product_image_key(image.key):
            raise ValueError("refusing a key outside products/<uuid>/<sha256>.<ext>")
        if len(data) != image.size:
            raise ValueError("data does not match the prepared image")
        stored = StoredObject(
            key=image.key,
            content_type=image.content_type,
            size=image.size,
            sha256_hex=image.sha256_hex,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
        self.objects[image.key] = (stored, data)
        return stored

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)
        self.deleted.append(key)

    async def exists(self, key: str) -> bool:
        return key in self.objects
