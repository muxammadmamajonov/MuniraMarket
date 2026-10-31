"""Round-trip one image through the configured object storage, then remove it.

``python -m app.dev.storage_smoke``

Uses exactly what the API uses (:func:`app.storage.images.create_image_storage` with the
``OBJECT_STORAGE_*`` settings): writes a 1x1 PNG under a random ``products/<uuid>/`` key, checks
it exists, deletes it and checks it is gone. Exits non-zero if storage is disabled or any step
fails; the object is deleted even when a check fails.
"""

import asyncio
import base64
import sys
import uuid

from app.core.config import get_settings
from app.domain.product_image import prepare_product_image
from app.storage.images import DisabledImageStorage, create_image_storage

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
)


async def run() -> int:
    storage = create_image_storage(get_settings())
    if isinstance(storage, DisabledImageStorage):
        sys.stderr.write("object storage is not configured (OBJECT_STORAGE_* unset)\n")
        return 1
    image = prepare_product_image(uuid.uuid4(), PNG_1X1, filename="smoke.png")
    try:
        stored = await storage.put(image, PNG_1X1)
        sys.stdout.write(f"ok  put {stored.key} ({stored.size} bytes, {stored.content_type})\n")
        if not await storage.exists(image.key):
            sys.stderr.write("FAIL object missing after put\n")
            return 1
        sys.stdout.write("ok  exists after put\n")
    finally:
        await storage.delete(image.key)
    if await storage.exists(image.key):
        sys.stderr.write("FAIL object still present after delete\n")
        return 1
    sys.stdout.write("ok  gone after delete\nobject storage smoke passed\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
