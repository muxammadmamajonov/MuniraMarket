'use client';

import { useState, type ImgHTMLAttributes } from 'react';
import { cx } from '../cx';

export interface ImagePlaceholderProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'alt' | 'children'
> {
  /** Image URL; `null`/empty shows the placeholder. Also shown if the image fails to load. */
  src: string | null | undefined;
  alt: string;
  /** Classes of the square wrapper (size, rounding). */
  className?: string;
}

/**
 * Square product image with a neutral placeholder for missing or broken images, so layouts never
 * collapse. The placeholder carries the product name as its accessible name.
 */
export function ImagePlaceholder({ src, alt, className, ...rest }: ImagePlaceholderProps) {
  // Remember which URL failed so a different `src` gets a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = typeof src === 'string' && src !== '' && failedSrc !== src;
  // Tailwind does not de-duplicate conflicting utilities: a caller-provided `w-*` must replace the
  // default `w-full`, otherwise the CSS source order decides and a fixed-width thumbnail in a flex
  // row can expand to the full row and cover the controls next to it.
  const hasOwnWidth = /(^|\s)w-/.test(className ?? '');

  return (
    <div
      className={cx(
        'relative aspect-square overflow-hidden rounded-xl bg-surface-muted',
        !hasOwnWidth && 'w-full',
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
          {...rest}
        />
      ) : (
        <div
          data-testid="image-placeholder"
          role="img"
          aria-label={alt}
          className="flex h-full w-full items-center justify-center text-muted-foreground"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-1/3 w-1/3 opacity-60"
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="1.75" />
            <path d="m21 15-4.5-4.5L6 21" />
          </svg>
        </div>
      )}
    </div>
  );
}
