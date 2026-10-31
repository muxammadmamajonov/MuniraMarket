# R2: product images (foundation only)

R2 is the chosen store for product images. **Nothing is enabled yet**: no bucket, credential,
CORS rule, custom domain or upload exists, and the admin shows a placeholder instead of a preview.
Until then a product's `image_url` may hold any public `https` URL (validated by
`app/domain/image_url.py`), exactly as today.

What exists in code:

- `app/domain/product_image.py`: the rules below, as pure functions.
- `app/storage/images.py`: the `ImageStorage` interface, `DisabledImageStorage` (fails closed,
  the default) and `InMemoryImageStorage` (test double). Tests: `tests/test_product_image.py`.

## Rules

| Rule            | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| Types           | JPEG, PNG, WebP, decided by magic bytes; SVG/HTML/GIF/PDF refused whatever the filename |
| Size            | 1 byte to 5 MiB per file                                                                |
| Object key      | `products/<product uuid>/<sha256 hex>.<jpg\|png\|webp>`; no user text in keys           |
| Integrity       | server-computed SHA-256, sent as `x-amz-checksum-sha256` so R2 rejects corrupt uploads  |
| Caching         | content-addressed, so `Cache-Control: public, max-age=31536000, immutable`              |
| Filename        | original name kept only as sanitised display metadata (no path, controls, bidi)         |
| URL in database | `https://<image CDN host>/<key>`: an ordinary `https` URL, so pasted URLs keep working  |

## Upload flow (when enabled)

1. Admin (role `admin`, CSRF, rate-limited) sends the file to the Core API through the admin
   proxy. The browser never sees bucket credentials or the bucket name.
2. The API validates (`prepare_product_image`), stores via `ImageStorage.put`, and saves the public
   URL on the product in the same request; the audit log records the change.
3. Later option for large files: the API issues a short-lived pre-signed `PUT` for one exact key,
   content type, length and checksum; the browser uploads directly; the API verifies the object
   (`exists`, size, checksum) before attaching it to the product.

Recommended adapter: the gateway Worker owns an **R2 binding** and exposes a narrow internal
upload/delete method to the container, so no S3 access key exists at all. If the S3 API is used
instead, the key pair is scoped to one bucket with object read/write only and stored as a gateway
Worker secret.

## Lifecycle

- Objects are immutable; replacing an image writes a new key.
- An object is deleted only when no product references it **and** a grace period (7 days) has
  passed, covering rollbacks, open admin tabs and CDN caches. Archived products keep their image.
- Bucket lifecycle rule: abort incomplete multipart uploads after 1 day; if a `tmp/` prefix is
  introduced for pre-signed uploads, expire it after 1 day.

## Enablement checklist (per environment)

- [ ] Create bucket `muniramarket-images-<env>` (location close to users); public access only
      through a custom domain (no `r2.dev` URL in production).
- [ ] Custom domain for images on the zone (e.g. an `img.` host), cached by Cloudflare.
- [ ] Add the binding to `services/api-gateway/cloudflare.config.ts` (`bindings.r2({ name })`)
      and implement the R2 adapter behind `ImageStorage`; keep `DisabledImageStorage` for any
      environment without a bucket.
- [ ] CORS on the bucket only if pre-signed browser uploads are used: allow `PUT` from the admin
      origin only.
- [ ] Admin CSP: add the image host to `img-src` in `apps/admin/src/lib/csp.ts` (allow-list one
      exact `https://` host, never `https:`), then flip the admin preview flag.
- [ ] Storefront CSP already allows `https:` images; tighten it to the image host when all
      images live in R2.
- [ ] Upload, replace and delete tested on staging with throw-away images; no customer data in
      object metadata.
