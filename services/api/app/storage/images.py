"""Product image storage adapter (S3-compatible: Neon Object Storage or R2), behind an interface.

:func:`create_image_storage` returns :class:`S3ImageStorage` when ``OBJECT_STORAGE_*`` is set
(``python -m app.dev.neon_env`` fills it from ``neon deploy``), otherwise
:class:`DisabledImageStorage`. Tests use :class:`InMemoryImageStorage`.

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

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import Settings
from app.domain.product_image import IMMUTABLE_CACHE_CONTROL, PreparedImage, is_product_image_key

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


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


class S3ImageStorage:
    """Any S3-compatible bucket: Neon Object Storage (``buckets.assets`` in neon.ts) or R2.

    boto3 is synchronous, so each call runs in a worker thread. The SHA-256 checksum is sent
    with the ``PUT``, so the store rejects bytes that do not match what was validated.
    """

    def __init__(
        self,
        *,
        bucket: str,
        endpoint_url: str,
        region: str,
        access_key_id: str,
        secret_access_key: str,
    ) -> None:
        self._bucket = bucket
        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=BotoConfig(
                connect_timeout=5, read_timeout=15, retries={"max_attempts": 3, "mode": "standard"}
            ),
        )

    async def put(self, image: PreparedImage, data: bytes) -> StoredObject:
        if not is_product_image_key(image.key):
            raise ValueError("refusing a key outside products/<uuid>/<sha256>.<ext>")
        if len(data) != image.size:
            raise ValueError("data does not match the prepared image")
        try:
            await asyncio.to_thread(
                self._client.put_object,
                Bucket=self._bucket,
                Key=image.key,
                Body=data,
                ContentType=image.content_type,
                CacheControl=IMMUTABLE_CACHE_CONTROL,
                ChecksumSHA256=image.sha256_base64,
            )
        except (BotoCoreError, ClientError) as exc:
            raise ImageStorageUnavailableError("image storage write failed") from exc
        return StoredObject(
            key=image.key,
            content_type=image.content_type,
            size=image.size,
            sha256_hex=image.sha256_hex,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )

    async def delete(self, key: str) -> None:
        try:
            await asyncio.to_thread(self._client.delete_object, Bucket=self._bucket, Key=key)
        except (BotoCoreError, ClientError) as exc:
            raise ImageStorageUnavailableError("image storage delete failed") from exc

    async def exists(self, key: str) -> bool:
        try:
            await asyncio.to_thread(self._client.head_object, Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise ImageStorageUnavailableError("image storage lookup failed") from exc
        except BotoCoreError as exc:
            raise ImageStorageUnavailableError("image storage lookup failed") from exc
        return True


def create_image_storage(settings: Settings) -> ImageStorage:
    """The S3 adapter when object storage is configured, otherwise fail closed."""
    if settings.object_storage_bucket is None:
        return DisabledImageStorage()
    assert settings.object_storage_endpoint_url is not None  # noqa: S101 (settings validator)
    assert settings.object_storage_access_key_id is not None  # noqa: S101
    assert settings.object_storage_secret_access_key is not None  # noqa: S101
    return S3ImageStorage(
        bucket=settings.object_storage_bucket,
        endpoint_url=settings.object_storage_endpoint_url,
        region=settings.object_storage_region,
        access_key_id=settings.object_storage_access_key_id.get_secret_value(),
        secret_access_key=settings.object_storage_secret_access_key.get_secret_value(),
    )
