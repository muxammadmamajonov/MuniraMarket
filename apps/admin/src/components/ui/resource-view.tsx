'use client';

import { EmptyState, ErrorState, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { readErrorMessage } from '@/lib/api/error-messages';
import { useSession } from '@/lib/session';
import type { ApiResource } from '@/lib/use-api-resource';
import { LINK_BUTTON } from './classes';
import { cx } from '@muniramarket/ui';

/** "You are not allowed here": shown for admin-only pages to operators, and on any API 403. */
export function PermissionDenied() {
  const { dict, locale } = useI18n();
  return (
    <section
      role="alert"
      data-testid="permission-denied"
      className="mx-auto flex w-full max-w-md flex-col items-start gap-3 rounded-xl border border-border bg-surface p-6"
    >
      <h1 className="text-xl font-bold">{dict.permission.title}</h1>
      <p className="text-muted-foreground">{dict.permission.message}</p>
      <Link href={`/${locale}`} className={LINK_BUTTON}>
        {dict.permission.home}
      </Link>
    </section>
  );
}

/**
 * Admin-only pages render this around their content: an operator sees "permission denied" and the
 * page never mounts, so it makes no admin-only request. Core API enforces the same rule (403 before
 * any entity is read); this is the friendly version.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useSession();
  return isAdmin ? children : <PermissionDenied />;
}

export interface ResourceViewProps<T> {
  resource: ApiResource<T>;
  /** Accessible name of the loading skeleton. */
  loadingLabel: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * The four states every data screen has: skeleton while loading, permission denied (API 403),
 * error with retry (network / 5xx / 429 / anything else), and the content. While a refresh for a
 * changed filter is in flight the previous content stays, dimmed, with `aria-busy`.
 */
export function ResourceView<T>({
  resource,
  loadingLabel,
  skeleton,
  children,
}: ResourceViewProps<T>) {
  const { dict } = useI18n();

  if (resource.status === 'loading') {
    return (
      <div role="status" aria-label={loadingLabel} className="flex flex-col gap-3">
        {skeleton ?? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        )}
      </div>
    );
  }

  if (resource.status === 'error' && resource.error !== null) {
    if (resource.error.code === 'forbidden') return <PermissionDenied />;
    return (
      <ErrorState
        title={dict.errors.title}
        description={readErrorMessage(dict, resource.error)}
        retryLabel={dict.errors.retry}
        onRetry={resource.reload}
      />
    );
  }

  return (
    <div aria-busy={resource.fetching} className={cx(resource.fetching && 'mm-busy')}>
      {resource.data === null ? null : children(resource.data)}
    </div>
  );
}

export { EmptyState };
