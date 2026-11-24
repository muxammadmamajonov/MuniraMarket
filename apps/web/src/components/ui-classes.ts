/**
 * Shared class strings for the storefront (Tailwind v4; `hover:` is already gated behind
 * `(hover: hover)`). Press feedback uses `:active` (works for touch, mouse and keyboard
 * activation), scale 0.97 over 150ms with the strong ease-out, transform only.
 *
 * Shape hierarchy, so radius carries meaning instead of being one value everywhere:
 *   group / section  24px  (`GROUP`, `CARD`): borderless white block on the warm grey page
 *   tile / image     20px  (product photos, category tiles)
 *   control          16px  (buttons, inputs) or a full pill (steppers, chips, round add button)
 */

export const PRESS =
  'transition-[transform,background-color] duration-150 ease-out-strong active:scale-[0.97] ' +
  'motion-reduce:transition-none';

export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A link that looks like the primary button (52px, full-strength brand red). */
export const LINK_BUTTON_PRIMARY =
  `inline-flex min-h-13 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-[17px] font-semibold ` +
  `text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`;

/** Quiet secondary action: a tinted fill instead of an outline. */
export const LINK_BUTTON_SECONDARY =
  `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-surface-muted px-5 ` +
  `font-semibold text-foreground hover:bg-border ${PRESS} ${FOCUS_RING}`;

/** Text inputs, selects and textareas: 16px (global rule), 48px tall, invalid state from aria. */
export const INPUT =
  'min-h-12 w-full min-w-0 scroll-mb-32 rounded-2xl border border-transparent bg-surface-muted px-3.5 py-2 ' +
  'text-foreground placeholder:text-muted-foreground ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft ' +
  'focus-visible:border-border-strong focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** A grouped block: white on the page, no border, 24px corners. */
export const GROUP = 'rounded-3xl bg-surface';

/** A grouped block with the standard inner padding (sections of checkout, order, profile). */
export const CARD = `${GROUP} p-4`;

/** Rows inside a `GROUP`: an inset hairline between them, none above the first. */
export const ROWS = 'divide-y divide-hairline';

/** Section heading inside a group. */
export const SECTION_TITLE = 'text-lg leading-6 font-bold tracking-[-0.01em]';

/** Page title (h1). */
export const PAGE_TITLE = 'text-[28px] leading-8 font-bold tracking-[-0.025em]';

export const ERROR_TEXT = 'text-sm font-medium text-danger';
