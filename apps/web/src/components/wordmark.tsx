import { useId } from 'react';
import { MARK_VIEWBOX, markSvgBody } from '@/brand/munira-mark';

/**
 * MuniraMarket logo. `MuniraMark` renders the shared flat mark from `brand/munira-mark.ts` (the
 * same function writes the exported files in `public/brand/`), so the app and the files can never
 * drift apart. The markup is a constant built from our own geometry, never user data, which is
 * why injecting it as HTML is safe.
 *
 * The logo keeps the sign's deep red on light and dark backgrounds alike: it is a logotype, which
 * WCAG exempts from text-contrast minimums.
 */
export interface MuniraMarkProps {
  className?: string;
  /** Accessible name; omit when the surrounding control already names the brand. */
  title?: string;
}

export function MuniraMark({ className, title }: MuniraMarkProps) {
  const id = `mm-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const decorative = title === undefined;
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width="48"
      height="48"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={title}
      focusable="false"
      data-testid="munira-mark"
      dangerouslySetInnerHTML={{ __html: markSvgBody('var(--mm-color-wordmark-primary)', id) }}
    />
  );
}

export interface WordmarkProps {
  /** Brand name used as the accessible label of the whole lockup (e.g. "MuniraMarket"). */
  name: string;
}

/**
 * Lockup as on the shop sign: the cart mark, MUNIRA in deep red and MARKET in charcoal (white on
 * dark), heavy caps. One line from 400px; on narrower phones the two words stack so the header
 * keeps a single row. The letters are presentational; the name is exposed once as the label.
 */
export function Wordmark({ name }: WordmarkProps) {
  return (
    <span role="img" aria-label={name} className="inline-flex items-center gap-1">
      <MuniraMark className="size-9 shrink-0" />
      <span
        aria-hidden="true"
        className="flex flex-col text-[13px] leading-[0.95] font-black tracking-[-0.01em] whitespace-nowrap min-[400px]:flex-row min-[400px]:gap-[0.3em] min-[400px]:text-[17px]"
      >
        <span className="text-(--mm-color-wordmark-primary)">MUNIRA</span>
        <span className="text-(--mm-color-wordmark-secondary)">MARKET</span>
      </span>
    </span>
  );
}
