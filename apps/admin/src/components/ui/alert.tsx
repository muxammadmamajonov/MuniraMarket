import { cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';

// Brand tokens only (packages/ui/src/styles/tokens.css): each pair is AA in light and dark.
const TONES = {
  error: 'border-danger/40 bg-danger-soft text-danger',
  success: 'border-success/40 bg-success-soft text-success',
  info: 'border-border bg-surface-muted text-foreground',
  warning: 'border-warning/40 bg-warning-soft text-warning',
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
