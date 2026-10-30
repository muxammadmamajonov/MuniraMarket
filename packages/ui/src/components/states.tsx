import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { Button } from './button';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string;
  description?: string;
  /** Optional call to action (link or button). */
  action?: ReactNode;
}

/** Centered message for "nothing here" situations (empty cart, no search results). */
export function EmptyState({ title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div
      className={cx('flex flex-col items-center gap-3 px-4 py-12 text-center', className)}
      {...rest}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string;
  description?: string;
  /** When both are set, a retry button is rendered. */
  retryLabel?: string;
  onRetry?: () => void;
}

/** Announced error message with an optional retry button. */
export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  className,
  ...rest
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx('flex flex-col items-center gap-3 px-4 py-12 text-center', className)}
      {...rest}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-muted-foreground">{description}</p> : null}
      {retryLabel && onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
