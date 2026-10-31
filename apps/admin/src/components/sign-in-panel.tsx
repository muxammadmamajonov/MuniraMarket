'use client';

import type { AuthConfig } from '@muniramarket/contracts';
import { ErrorState, Skeleton } from '@muniramarket/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { TelegramLoginButton } from './telegram-login-button';

type ConfigState =
  { key: number; status: 'ready'; config: AuthConfig } | { key: number; status: 'failed' };

/** `GET /auth/config`, fetched while a visitor without a session needs to sign in. */
function useAuthConfig(attempt: number): ConfigState | null {
  const { apiFetch } = useSession();
  const [state, setState] = useState<ConfigState | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/auth/config')
      .then(async (response) => {
        if (!response.ok) throw new Error('auth config unavailable');
        const config = await readJson<AuthConfig>(response);
        if (!cancelled) setState({ key: attempt, status: 'ready', config });
      })
      .catch(() => {
        if (!cancelled) setState({ key: attempt, status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, apiFetch]);

  // A result for an older attempt means the retry is still loading.
  return state?.key === attempt ? state : null;
}

/**
 * Shown to a visitor without a session: the Telegram Login Widget when the API enables it, a clear
 * "not configured" screen when it does not. Nothing here touches order data.
 */
export function SignInPanel() {
  const { dict } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const config = useAuthConfig(attempt);

  if (config === null) {
    return (
      <div role="status" aria-label={dict.auth.checking} className="mx-auto w-full max-w-md">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (config.status === 'failed') {
    return (
      <ErrorState
        title={dict.errors.title}
        description={dict.auth.configFailed}
        retryLabel={dict.auth.retry}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  const widget = config.config.telegram_login_widget;
  if (!widget.enabled || widget.bot_username === null) {
    return (
      <section
        role="status"
        className="mx-auto flex w-full max-w-md flex-col gap-2 rounded-xl border border-border bg-surface p-6"
      >
        <h1 className="text-xl font-bold">{dict.auth.notConfiguredTitle}</h1>
        <p className="text-muted-foreground">{dict.auth.notConfiguredMessage}</p>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-surface p-6">
      <h1 className="text-xl font-bold">{dict.auth.signInTitle}</h1>
      <p className="text-muted-foreground">{dict.auth.signInHint}</p>
      <TelegramLoginButton botUsername={widget.bot_username} />
    </section>
  );
}
