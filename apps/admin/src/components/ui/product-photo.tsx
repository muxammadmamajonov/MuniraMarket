'use client';

import { cx } from '@muniramarket/ui';
import { useState } from 'react';
import { ownPhotoPath } from '@/lib/photo';

/**
 * A product or category photo on the store's photo tile (`.mm-photo`, shared with the storefront
 * in `@muniramarket/ui/styles/photo.css`): our own photos are transparent cut-outs, shown whole on
 * a warm neutral tile with a soft contact shadow, exactly as customers see them. Anything else
 * (no photo, a pasted external link the admin's CSP will not load, a file that fails) shows a
 * quiet placeholder of the same size, so rows never shift.
 *
 * Decorative by default (`alt=""`): next to a name the photo adds nothing for a screen reader.
 */
export function ProductPhoto({
  src,
  alt = '',
  size = 'thumb',
  className,
}: {
  src: string | null | undefined;
  alt?: string;
  size?: 'thumb' | 'full';
  /** Box classes: width and rounding. Square. */
  className?: string;
}) {
  const path = ownPhotoPath(src, size);
  // Remember which path failed so a different photo gets a fresh attempt.
  const [failed, setFailed] = useState<string | null>(null);
  const show = path !== null && failed !== path;

  return (
    <span
      data-cutout={show ? 'tile' : undefined}
      data-testid="product-photo"
      className={cx(
        'mm-photo relative block aspect-square shrink-0 overflow-hidden rounded-xl',
        className,
      )}
    >
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element -- static same-origin files, no optimizer
        <img
          src={path}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(path)}
          className="absolute inset-0 size-full object-contain p-[9%]"
        />
      ) : (
        <span
          data-testid="photo-placeholder"
          {...(alt === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt })}
          className="absolute inset-0 flex items-center justify-center text-muted-foreground/70"
        >
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-[38%]"
          >
            <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
            <path d="m3 8 9 5 9-5M12 13v8" />
          </svg>
        </span>
      )}
    </span>
  );
}
