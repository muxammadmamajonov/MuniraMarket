'use client';

import { Button, ErrorState, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { sessionErrorMessage } from '@/lib/api/error-messages';
import { useSession } from '@/lib/session';
import { LanguageSwitcher } from './language-switcher';
import { SignInPanel } from './sign-in-panel';

function LogoutButton() {
  const { dict } = useI18n();
  const { logout } = useSession();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const onClick = () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    logout()
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button variant="secondary" onClick={onClick} disabled={pending}>
        {dict.header.logout}
      </Button>
      {failed ? (
        <span role="alert" className="text-sm text-red-700 dark:text-red-300">
          {dict.errors.serviceUnavailable}
        </span>
      ) : null}
    </>
  );
}

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
 * Frame of every back-office page and, more importantly, its gate: `children` (the order screens,
 * which fetch order data on mount) are rendered only for a signed-in operator/admin. While the
 * session is being checked, for visitors without a session, after a failure and for customers,
 * nothing below the gate is mounted, so no `/admin/**` request is made.
 *
 * This is a UI convenience; Core API independently refuses `/admin/**` to everyone else.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { dict, locale } = useI18n();
  const { status, user, isStaff, error, retry } = useSession();

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
    content = isStaff ? children : <AccessDenied />;
  }

  return (
    <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
      <header className="border-b border-border bg-surface">
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
