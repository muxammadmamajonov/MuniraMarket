/**
 * Shared class strings, the same vocabulary as the storefront (`apps/web/src/components/ui-classes.ts`),
 * so the back office reads as the same shop. Every pressable thing is >= 44px tall and answers a
 * press with `scale(0.97)` (transform only, the strong ease-out).
 *
 * Shape hierarchy, so radius carries meaning instead of being one value everywhere:
 *   group / section  24px  (`GROUP`, `CARD`): borderless white block on the warm grey page
 *   photo tile       12px  (`ProductPhoto`)
 *   control          16px  (buttons, inputs) or a full pill (filter chips, status badges)
 */

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export const PRESS =
  'transition-[transform,background-color] duration-150 ease-out-strong active:scale-[0.97] ' +
  'motion-reduce:transition-none';

/** Filter chip / segmented link: a pill; the current one is charcoal, as on the storefront. */
export const CHIP =
  'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap ' +
  PRESS +
  ' ' +
  FOCUS;
export const CHIP_ON = 'bg-foreground text-background';
export const CHIP_OFF = 'mm-chip-off bg-surface text-foreground hover:bg-surface-muted';

/**
 * A row of chips: wraps on wider screens; on phones one line that scrolls sideways edge to edge
 * (as on the storefront), so filters never take three rows above the list. Items are `shrink-0`.
 */
export const CHIP_RAIL =
  'mm-rail flex gap-2 sm:flex-wrap ' +
  'max-sm:-mx-4 max-sm:snap-x max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:px-4 max-sm:py-0.5 ' +
  '[&>li]:shrink-0 [&>li]:snap-start';

/** A link that looks like a secondary button: white on the page, no outline. */
export const LINK_BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-surface px-4 ' +
  'font-semibold text-foreground shadow-[0_1px_2px_rgb(20_20_22/0.06)] hover:bg-surface-muted ' +
  PRESS +
  ' ' +
  FOCUS;

export const LINK_BUTTON_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-4 font-semibold ' +
  'text-primary-foreground hover:bg-primary-hover ' +
  PRESS +
  ' ' +
  FOCUS;

/** Plain inline text link. */
export const TEXT_LINK = 'font-medium underline underline-offset-2 ' + FOCUS;

/**
 * Text inputs and textareas: a filled field (no outline until focus), 16px text (global rule),
 * invalid state from `aria-invalid`. On a white group the fill reads as the field; on the page it
 * turns white.
 */
export const INPUT =
  'min-h-11 w-full min-w-0 rounded-2xl border border-transparent bg-surface-muted px-3.5 text-base ' +
  'text-foreground placeholder:text-muted-foreground ' +
  'aria-invalid:border-danger aria-invalid:bg-danger-soft ' +
  'focus-visible:border-border-strong focus-visible:bg-surface focus-visible:outline-2 ' +
  'focus-visible:outline-offset-0 focus-visible:outline-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** The same field standing on the page (search and filter bars): white, with a hairline shadow. */
export const INPUT_ON_PAGE = INPUT.replace(
  'bg-surface-muted',
  'mm-field-page bg-surface shadow-[0_1px_2px_rgb(20_20_22/0.06)]',
);

export const TEXTAREA = INPUT.replace('min-h-11 ', 'min-h-24 py-2.5 ');

export const ALERT_TEXT = 'text-sm text-danger';

/** A grouped block: white on the page, no border, 24px corners. */
export const GROUP = 'rounded-3xl bg-surface';

/** A grouped block with the standard inner padding (form sections, order sections). */
export const CARD = `flex min-w-0 flex-col gap-3 ${GROUP} p-4 sm:p-5`;

/** Section heading inside a group. */
export const SECTION_TITLE = 'text-lg leading-6 font-bold tracking-[-0.01em]';

/**
 * A tappable list row on phones (inside a `GROUP` with `ROWS`): content first, the whole row opens
 * the item, a tint while pressed (no scale: rows are wide and many).
 */
export const ROW_LINK =
  'flex min-h-[4.5rem] items-center gap-3 px-4 py-3 transition-colors duration-150 ' +
  'active:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/** Rows inside a `GROUP`: an inset hairline between them, none above the first. */
export const ROWS = 'divide-y divide-hairline';

export const ICON_BUTTON = FOCUS;
