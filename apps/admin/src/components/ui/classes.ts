/** Shared class strings. Every pressable thing is >= 44px tall and shows `:active` feedback. */

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** Filter chip / segmented link. */
export const CHIP =
  'inline-flex min-h-11 items-center rounded-xl border px-3 text-sm font-medium ' +
  'transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] ' +
  FOCUS;
export const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
export const CHIP_OFF = 'border-border bg-surface text-foreground hover:bg-surface-muted';

/** A link that looks like a secondary button. */
export const LINK_BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface px-4 ' +
  'font-semibold text-foreground transition-[background-color,transform] duration-150 ease-out ' +
  'hover:bg-surface-muted active:scale-[0.98] ' +
  FOCUS;

export const LINK_BUTTON_PRIMARY =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 font-semibold ' +
  'text-primary-foreground transition-[background-color,transform] duration-150 ease-out ' +
  'hover:bg-primary-hover active:scale-[0.98] ' +
  FOCUS;

/** Plain inline text link. */
export const TEXT_LINK = 'font-medium underline underline-offset-2 ' + FOCUS;

export const INPUT =
  'min-h-11 w-full rounded-xl border border-border bg-background px-3 text-base ' +
  'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-invalid:border-red-600 dark:aria-invalid:border-red-400 ' +
  'focus-visible:outline-2 focus-visible:outline-focus';

export const TEXTAREA = INPUT.replace('min-h-11 ', 'min-h-24 py-2 ');

export const ALERT_TEXT = 'text-sm text-red-700 dark:text-red-300';

export const CARD = 'flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4';

export const ICON_BUTTON = FOCUS;
