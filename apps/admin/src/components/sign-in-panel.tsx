'use client';

import type { AuthConfig } from '@muniramarket/contracts';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { AuthCard, AuthCardSkeleton, AuthErrorCard } from './auth-card';
import { TelegramLoginButton } from './telegram-login-button';

type ConfigState =
  | { key: number; status: 'ready'; config: AuthConfig }
  | { key: number; status: 'failed'; error: ApiRequestError };

/** `GET /auth/config`, fetched while a visitor without a session needs to sign in. */
function useAuthConfig(attempt: number): ConfigState | null {
  const { apiFetch } = useSession();
  const [state, setState] = useState<ConfigState | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/auth/config')
      .then(async (response) => {
        if (!response.ok) throw await ApiRequestError.fromResponse(response);
        const config = await readJson<AuthConfig>(response);
        if (!cancelled) setState({ key: attempt, status: 'ready', config });
      })
      .catch((cause: unknown) => {
        const error = cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause);
        if (!cancelled) setState({ key: attempt, status: 'failed', error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, apiFetch]);

  // A result for an older attempt means the retry is still loading.
  return state?.key === attempt ? state : null;
}

/**
 * Shown to a visitor without a session: the "Sign in with Telegram" button when the API enables
 * it, a clear "not configured" screen when it does not, and a retryable error with a support code
 * when the settings could not be loaded. Nothing here touches order data.
 */
export function SignInPanel() {
  const { dict } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const config = useAuthConfig(attempt);

  if (config === null) return <AuthCardSkeleton label={dict.auth.checking} />;

  if (config.status === 'failed') {
    return (
      <AuthErrorCard
        title={dict.errors.title}
        description={dict.auth.configFailed}
        supportCode={config.error.supportCode}
        retryLabel={dict.auth.retry}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  if (!config.config.telegram_oidc.enabled) {
    return (
      <AuthCard
        role="status"
        title={dict.auth.notConfiguredTitle}
        description={dict.auth.notConfiguredMessage}
      />
    );
  }

  return (
    <AuthCard
      title={dict.auth.signInTitle}
      description={dict.auth.signInHint}
      footer={dict.auth.staffOnly}
      testId="sign-in-card"
    >
      <TelegramLoginButton />
    </AuthCard>
  );
}
