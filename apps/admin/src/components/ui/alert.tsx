import { cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';

const TONES = {
  error:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
  success:
    'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100',
  info: 'border-border bg-surface-muted text-foreground',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
} as const;

/**
 * An inline message. `error` is announced immediately (`role="alert"`), the others politely
 * (`role="status"`). Colour never carries the meaning alone: the text does.
 */
export function Alert({
  tone,
  children,
  className,
  testId,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={cx('rounded-xl border px-3 py-2 text-sm break-words', TONES[tone], className)}
    >
      {children}
    </div>
  );
}
