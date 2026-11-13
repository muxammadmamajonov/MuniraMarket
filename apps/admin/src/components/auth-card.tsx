'use client';

import { Button, cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';
import { BrandMark } from './brand';
import { SupportCode } from './ui/support-code';

/**
 * The one card every signed-out state uses (sign in, checking, not configured, errors, access
 * denied, the sign-in failure page): brand mark, a heading, one short explanation and at most one
 * primary action, centered at a comfortable reading width. Keeping these states in one shape
 * makes the difference between them the words, not the layout.
 */
export function AuthCard({
  title,
  description,
  tone = 'neutral',
  role,
  children,
  footer,
  testId,
}: {
  title: string;
  description?: ReactNode;
  /** `danger` tints the mark's halo for failures; never colour alone: the title says it. */
  tone?: 'neutral' | 'danger';
  /** `alert` for failures (announced), `status` for informational states. */
  role?: 'alert' | 'status';
  children?: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      role={role}
      data-testid={testId}
      className="mm-enter mx-auto flex w-full max-w-md flex-col gap-5 rounded-3xl bg-surface p-6 shadow-[0_1px_2px_rgb(20_20_22/0.04),0_8px_24px_-12px_rgb(20_20_22/0.12)] sm:p-8"
    >
      <span
        className={cx(
          'flex size-14 items-center justify-center rounded-2xl',
          tone === 'danger' ? 'bg-danger-soft' : 'bg-brand-soft',
        )}
      >
        <BrandMark className="size-10" />
      </span>
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold break-words sm:text-2xl">{title}</h1>
        {description === undefined ? null : (
          <div className="break-words text-muted-foreground">{description}</div>
        )}
      </div>
      {children}
      {footer === undefined ? null : (
        <div className="border-t border-hairline pt-4 text-sm text-muted-foreground">{footer}</div>
      )}
    </section>
  );
}

/** A failure inside an {@link AuthCard}: what happened, the support code and "Try again". */
export function AuthErrorCard({
  title,
  description,
  supportCode,
  retryLabel,
  onRetry,
  children,
}: {
  title: string;
  description: string;
  supportCode: string | null;
  retryLabel?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <AuthCard title={title} description={description} tone="danger" role="alert">
      <SupportCode code={supportCode} hint />
      {retryLabel !== undefined && onRetry !== undefined ? (
        <Button size="lg" onClick={onRetry} className="w-full" data-testid="auth-retry">
          {retryLabel}
        </Button>
      ) : null}
      {children}
    </AuthCard>
  );
}

/** Placeholder card while the session or the sign-in settings are being checked. */
export function AuthCardSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="mx-auto flex w-full max-w-md flex-col gap-5 rounded-3xl bg-surface p-6 sm:p-8"
    >
      <span className="size-14 rounded-2xl bg-surface-muted" />
      <span className="h-7 w-2/3 rounded-lg bg-surface-muted" />
      <span className="h-4 w-full rounded-lg bg-surface-muted" />
      <span className="h-12 w-full rounded-2xl bg-surface-muted" />
    </div>
  );
}
