import { cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';

// Brand tokens only (packages/ui/src/styles/tokens.css): each pair is AA in light and dark.
const TONES = {
  error: 'bg-danger-soft text-danger',
  success: 'bg-success-soft text-success',
  info: 'bg-surface-muted text-foreground',
  warning: 'bg-warning-soft text-warning',
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
      className={cx(
        'rounded-2xl px-4 py-3 text-sm font-medium break-words',
        TONES[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
