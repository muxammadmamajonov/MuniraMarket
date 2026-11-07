import { cx } from '@muniramarket/ui';

/**
 * Small busy indicator for buttons. It turns with `transform` only; under
 * `prefers-reduced-motion` it stands still (the button's label already says what is happening).
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      className={cx('mm-spin size-5 shrink-0', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
