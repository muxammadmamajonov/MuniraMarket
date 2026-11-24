'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { sessionErrorMessage } from '@/lib/api/error-messages';
import { useSession } from '@/lib/session';
import { StaffFrame } from './admin-nav';
import { AuthCard, AuthCardSkeleton, AuthErrorCard } from './auth-card';
import { BrandLockup } from './brand';
import { LanguageSwitcher } from './language-switcher';
import { LogoutButton } from './logout-button';
import { SignInPanel } from './sign-in-panel';

function AccessDenied() {
  const { dict } = useI18n();
  return (
    <AuthCard
      role="alert"
      tone="danger"
      title={dict.auth.accessDeniedTitle}
      description={dict.auth.accessDeniedMessage}
    >
      <div>
        <LogoutButton />
      </div>
    </AuthCard>
  );
}

/**
 * Frame of every back-office page and, more importantly, its gate: `children` (the screens, which
 * fetch data on mount) are rendered only for a signed-in operator/admin. While the session is
 * being checked, for visitors without a session, after a failure and for customers, nothing below
 * the gate is mounted, so no `/admin/**` request is made.
 *
 * Staff get the role-aware navigation (`admin-nav.tsx`): operators see the dashboard and orders,
 * admins also catalog, users and audit. That filtering is a convenience: admin-only pages
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
    content = <AuthCardSkeleton label={dict.auth.checking} />;
  } else if (status === 'error') {
    content = (
      <AuthErrorCard
        title={dict.errors.title}
        description={sessionErrorMessage(dict, error)}
        supportCode={error?.supportCode ?? null}
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
      <header className="border-b border-hairline bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <Link
            href={`/${locale}`}
            className="flex min-h-12 items-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <BrandLockup appName={dict.header.appName} tag={dict.header.brandTag} />
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
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-6 sm:py-12">
        {content}
      </main>
    </div>
  );
}
