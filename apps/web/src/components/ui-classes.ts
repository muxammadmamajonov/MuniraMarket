/**
 * Shared class strings for the checkout and order screens (Tailwind v4; `hover:` is already
 * gated behind `(hover: hover)`). Press feedback uses `:active` (works for touch, mouse and
 * keyboard activation), scale 0.97 over 150ms with the strong ease-out, transform only.
 */

export const PRESS =
  'transition-[transform,background-color] duration-150 ease-out-strong active:scale-[0.97] ' +
  'motion-reduce:transition-none';

export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A link that looks like the primary button (44px+ touch target). */
export const LINK_BUTTON_PRIMARY =
  `inline-flex min-h-12 items-center justify-center rounded-xl bg-primary px-6 text-lg font-semibold ` +
  `text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`;

export const LINK_BUTTON_SECONDARY =
  `inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface px-4 ` +
  `font-semibold text-foreground hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`;

/** Text inputs, selects and textareas: 16px (global rule), 44px tall, invalid state from aria. */
export const INPUT =
  'min-h-11 w-full min-w-0 scroll-mb-32 rounded-xl border border-border bg-surface px-3 py-2 ' +
  'text-foreground placeholder:text-muted-foreground ' +
  'aria-[invalid=true]:border-red-600 dark:aria-[invalid=true]:border-red-400 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const CARD = 'rounded-xl border border-border bg-surface p-4';

export const ERROR_TEXT = 'text-sm font-medium text-red-700 dark:text-red-400';
