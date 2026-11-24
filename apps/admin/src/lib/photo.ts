/**
 * The store's own photos in the back office. The demo catalog photos are static files of the
 * storefront, `/products/<name>.webp` and `/categories/<name>.webp` (800px), each with a 400px
 * `<name>-400.webp` next to it (see `services/api/app/ops/demo_images.py`); `image_url` holds the
 * bare path or the same path on the storefront origin. The admin serves the very same files from
 * its own origin (`apps/admin/public/{products,categories}` link to the storefront's folders), so
 * they load under the admin's `img-src 'self'` policy without allow-listing another host.
 *
 * Any other URL (an admin-pasted https link) is never loaded here: the CSP would block it and
 * report a violation. Those show the placeholder; the storefront still shows them.
 */
const OWN_PHOTO = /^(?:https:\/\/[a-z0-9.-]+)?(\/(?:products|categories)\/[a-z0-9-]+\.webp)$/;

/**
 * Same-origin path of one of our own photos, or `null` for anything else. `thumb` is the 400px
 * file (lists, order lines), `full` the 800px one (the product form preview).
 */
export function ownPhotoPath(
  src: string | null | undefined,
  size: 'thumb' | 'full' = 'thumb',
): string | null {
  if (typeof src !== 'string') return null;
  const match = OWN_PHOTO.exec(src.trim());
  const path = match?.[1];
  if (path === undefined) return null;
  if (size === 'full' || path.endsWith('-400.webp')) return path;
  return path.replace(/\.webp$/, '-400.webp');
}
