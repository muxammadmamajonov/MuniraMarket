/**
 * Configuration. The environment readers (`getApiInternalUrl`, `getClientIpHeader`) are only
 * imported by the API proxy (a Route Handler); client components may import only the pure feature
 * switches below (`isImagePreviewEnabled`), which read nothing from the environment. (`apps/web`
 * marks its twin with the `server-only` package; the admin does not depend on it, and nothing here
 * is a secret: `API_INTERNAL_URL` is simply never exposed to the browser because it is not
 * `NEXT_PUBLIC_`-prefixed.)
 */

const DEFAULT_API_INTERNAL_URL = 'http://localhost:8000';

/**
 * Base URL of the Core API as seen from the admin server (no trailing slash).
 *
 * Read at runtime from `API_INTERNAL_URL`: browsers reach the API through the same-origin proxy at
 * `/api/v1/*`, never directly.
 */
export function getApiInternalUrl(): string {
  const raw = process.env['API_INTERNAL_URL'];
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_API_INTERNAL_URL : raw.trim();
  return value.replace(/\/+$/, '');
}

/** HTTP header names are tokens; anything else in `CLIENT_IP_HEADER` is a misconfiguration. */
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * Name of the request header carrying the real client IP, set by the trusted edge in front of the
 * admin server (for example `x-real-ip`), or `null` when not configured.
 *
 * The edge MUST overwrite this header on every request; a client-sent value must never pass
 * through. When unset, the proxy forwards no client IP at all and Core API rate-limits by the admin
 * server's address (a shared bucket: stricter, but impossible to spoof).
 */
export function getClientIpHeader(): string | null {
  const raw = process.env['CLIENT_IP_HEADER']?.trim().toLowerCase();
  return raw !== undefined && HEADER_NAME.test(raw) ? raw : null;
}

/**
 * Whether the product form may load the image at `image_url` to preview it.
 *
 * Always `false` for now: the admin's Content-Security-Policy is `img-src 'self' data:` (see
 * `csp.ts`) and must stay that way, so an external image would only be blocked and reported as a
 * violation. Until image storage (R2) is enabled the form shows its placeholder and a note. This
 * flips to `true` together with allow-listing the R2 CDN hostname in `img-src`; both changes
 * belong in one commit. The `image_url` field itself, its validation and saving are unaffected
 * (an https URL still works on the storefront).
 */
export function isImagePreviewEnabled(): boolean {
  return false;
}
