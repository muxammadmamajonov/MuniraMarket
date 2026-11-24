'use client';

import { useCallback, useState } from 'react';
import { cx } from '@muniramarket/ui';
import { isCutout, photoSrcSet } from '@/lib/photo';
import { initialOf, toneFor } from '@/lib/placeholder';

export interface ProductImageProps {
  src: string | null;
  /** Localized product (or category) name: the accessible name and the monogram's letter. */
  name: string;
  /** Picks the tint: products of one category share a family. */
  toneKey: string;
  /** Box classes (size, shape, rounding). Square unless they set another aspect ratio. */
  className?: string;
  /** Layout width hint for the browser's pick of the 400/800px file (see `PHOTO_SIZES`). */
  sizes?: string;
  /**
   * No tile: a cut-out sits straight on the parent's own surface (the category mosaic's tinted
   * tile) with just its contact shadow. Other photos and the monogram keep their box.
   */
  bare?: boolean;
  /** Above the fold (the product page photo): load it eagerly. */
  priority?: boolean;
}

/**
 * `pending`: still loading when it mounted, so it is hidden and fades in on load. `instant`:
 * already decoded when it mounted (server-rendered and loaded before hydration, cache, back
 * navigation), so it simply stays. Before mount (server markup, hydration) it is `null` and the
 * photo is visible: it never depends on JavaScript to appear.
 */
type Shown = { src: string; how: 'pending' | 'fade' | 'instant' } | null;

/**
 * Product (or category) photo in a fixed box, so nothing shifts when it arrives. The box is the
 * store's photo tile (`.mm-photo`, globals.css): a warm neutral surface. Our own photos are
 * transparent cut-outs (`isCutout`), shown whole on the tile with a soft shadow under the
 * product, so the catalog reads as one set in both themes. Any other photo fills the box and, in
 * light mode, a white studio background blends into the tile. The photo fades in once decoded
 * (opacity only; the global reduced-motion rule makes it instant). Without a photo, or when it
 * fails to load, the box shows a soft tinted tile with the name's initial instead.
 */
export function ProductImage({
  src,
  name,
  toneKey,
  className,
  sizes,
  bare = false,
  priority = false,
}: ProductImageProps) {
  // Remember which URL failed or loaded, so a different `src` gets a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>(null);
  const hasPhoto = typeof src === 'string' && src !== '' && failedSrc !== src;
  const hasOwnAspect = /(^|\s)(max-\w+:)?aspect-/.test(className ?? '');
  const hasOwnWidth = /(^|\s)w-/.test(className ?? '');

  // Runs at commit, before the browser paints: a photo that is already there stays as it is, one
  // still loading is hidden until `onLoad` (which may already have fired before hydration, hence
  // the `complete` check instead of waiting for an event).
  const measure = useCallback(
    (img: HTMLImageElement | null) => {
      if (img === null || !src) return;
      const how = img.complete && img.naturalWidth > 0 ? 'instant' : 'pending';
      setShown((current) => (current?.src === src ? current : { src, how }));
    },
    [src],
  );

  const current = shown?.src === src ? shown.how : null;
  const visible = hasPhoto && current !== 'pending';
  const srcSet = hasPhoto ? photoSrcSet(src) : undefined;
  const cutout = hasPhoto && typeof src === 'string' && isCutout(src);

  return (
    <div
      data-cutout={cutout ? (bare ? 'bare' : 'tile') : undefined}
      className={cx(
        'mm-photo relative isolate overflow-hidden rounded-xl',
        !hasOwnAspect && 'aspect-square',
        !hasOwnWidth && 'w-full',
        className,
      )}
    >
      {hasPhoto ? (
        // Plain <img>: there is no image optimizer behind the Worker; our own photos come
        // pre-sized (400/800px WebP, `srcSet`), anything else is used as it is.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={measure}
          src={src}
          {...(srcSet === undefined ? {} : { srcSet, sizes: sizes ?? '100vw' })}
          alt={name}
          width={800}
          height={800}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          {...(priority ? { fetchPriority: 'high' as const } : {})}
          referrerPolicy="no-referrer"
          draggable={false}
          data-loaded={visible ? 'true' : 'false'}
          onLoad={() => {
            setShown((state) =>
              state?.src === src && state.how !== 'pending' ? state : { src, how: 'fade' },
            );
          }}
          onError={() => {
            setFailedSrc(src);
          }}
          className={cx(
            'absolute inset-0 h-full w-full select-none',
            cutout ? 'object-contain' : 'object-cover',
            visible ? 'opacity-100' : 'opacity-0',
            current === 'fade' && 'transition-opacity duration-300 ease-(--ease-out-strong)',
          )}
        />
      ) : (
        <div role="img" aria-label={name} data-testid="image-placeholder" className="h-full w-full">
          <Monogram letter={initialOf(name)} tone={toneFor(toneKey)} />
        </div>
      )}
    </div>
  );
}

export function Monogram({ letter, tone }: { letter: string; tone: number }) {
  return (
    <div
      aria-hidden="true"
      data-testid="monogram"
      data-tone={tone}
      className={`mm-tone-${String(tone)} @container relative flex h-full w-full items-center justify-center overflow-hidden bg-(--tone-bg) text-(--tone-fg)`}
    >
      <span className="absolute -right-[18%] -bottom-[18%] h-3/4 w-3/4 rounded-full bg-(--tone-fg) opacity-[0.08]" />
      <span className="relative text-[42cqw] leading-none font-semibold select-none">{letter}</span>
    </div>
  );
}
