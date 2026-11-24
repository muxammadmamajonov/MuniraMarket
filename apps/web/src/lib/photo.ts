/**
 * Responsive sources for the storefront's own photos. The demo catalog photos are static files
 * of this Worker, `/products/<name>.webp` and `/categories/<name>.webp` (800px), each with a
 * 400px `<name>-400.webp` next to it (see `services/api/app/ops/demo_images.py`). Their URL may be
 * a bare path or absolute on the storefront origin. Any other URL (an admin-pasted link, a future
 * R2 object under `products/<uuid>/<sha>.<ext>`) has a single size: no `srcSet`.
 */
const OWN_PHOTO = /^(?:https:\/\/[a-z0-9.-]+)?\/(?:products|categories)\/[a-z0-9-]+\.webp$/;

/**
 * Our own photos are product cut-outs: a transparent WebP, the product alone, centred with even
 * padding. They are shown whole on the CSS tile (`.mm-photo[data-cutout]`), which supplies the
 * backdrop and the shadow, so one file works in light and dark mode. Anything else is an ordinary
 * photo with its own background and fills its box.
 */
export function isCutout(src: string): boolean {
  return OWN_PHOTO.test(src);
}

export function photoSrcSet(src: string): string | undefined {
  if (!OWN_PHOTO.test(src) || src.endsWith('-400.webp')) return undefined;
  return `${src.replace(/\.webp$/, '-400.webp')} 400w, ${src} 800w`;
}

/** `sizes` for the places a photo appears; they follow the grids' column counts. */
export const PHOTO_SIZES = {
  /** Product grid: 2 columns, 3 from `sm`, 4 from `md` inside the 64rem page container. */
  tile: '(min-width: 1024px) 232px, (min-width: 768px) 25vw, (min-width: 640px) 33vw, 50vw',
  /** Product page: full width on phones, half the container from `md` (at most 28rem). */
  detail: '(min-width: 768px) 448px, 100vw',
  /** Cart line thumbnail. */
  thumb: '72px',
  /** Category rail and mosaic tiles. */
  category: '148px',
} as const;
