'use client';

import { ErrorState, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { sessionErrorMessage } from '@/lib/api/error-messages';
import { useSession } from '@/lib/session';
import { StaffFrame } from './admin-nav';
import { LanguageSwitcher } from './language-switcher';
import { LogoutButton } from './logout-button';
import { SignInPanel } from './sign-in-panel';

function AccessDenied() {
  const { dict } = useI18n();
  return (
    <section
      role="alert"
      className="mx-auto flex w-full max-w-md flex-col items-start gap-3 rounded-xl border border-border bg-surface p-6"
    >
      <h1 className="text-xl font-bold">{dict.auth.accessDeniedTitle}</h1>
      <p className="text-muted-foreground">{dict.auth.accessDeniedMessage}</p>
      <LogoutButton />
    </section>
  );
}

/**
 * Frame of every back-office page and, more importantly, its gate: `children` (the screens, which
 * fetch data on mount) are rendered only for a signed-in operator/admin. While the session is
 * being checked, for visitors without a session, after a failure and for customers, nothing below
 * the gate is mounted, so no `/admin/**` request is made.
 *
 * Staff get the role-aware navigation (`admin-nav.tsx`): operators see the dashboard and orders,
 * admins also catalog, delivery, users and audit. That filtering is a convenience: admin-only pages
 * check the role again (`AdminOnly`) and Core API independently answers 403 to an operator.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { dict, locale } = useI18n();
  const { status, user, isStaff, isAdmin, error, retry } = useSession();

  if (status === 'authenticated' && user !== null && isStaff) {
    return (
      <StaffFrame user={user} isAdmin={isAdmin}>
        {children}
      </StaffFrame>
    );
  }

  let content: ReactNode;
  if (status === 'loading') {
    content = (
      <div role="status" aria-label={dict.auth.checking}>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (status === 'error') {
    content = (
      <ErrorState
        title={dict.errors.title}
        description={sessionErrorMessage(dict, error)}
        retryLabel={dict.auth.retry}
        onRetry={retry}
      />
    );
  } else if (status === 'anonymous') {
    content = <SignInPanel />;
  } else {
    content = <AccessDenied />;
  }

  // Sign-in, loading, errors and "access denied" (a customer) get the plain frame: no navigation.
  return (
    <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
      <header className="border-b border-border bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <Link href={`/${locale}`} className="min-h-11 content-center text-lg font-bold">
            {dict.header.appName}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <LanguageSwitcher
              locale={locale}
              label={dict.header.language.label}
              names={dict.header.language.names}
            />
            {status === 'authenticated' && user !== null ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {user.first_name} · {dict.roles[user.role]}
                </span>
                <LogoutButton />
              </>
            ) : null}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{content}</main>
    </div>
  );
}
