'use client';

import type { AuthConfig } from '@muniramarket/contracts';
import { Button, Skeleton } from '@muniramarket/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';
import { CheckIcon, ShieldCheckIcon } from './icons';
import { TelegramLoginButton } from './telegram-login-button';
import { MuniraMark } from './wordmark';

type ConfigState =
  { status: 'loading' } | { status: 'ready'; config: AuthConfig } | { status: 'failed' };

/** `GET /auth/config`, fetched only while a plain-browser visitor needs to sign in. */
function useAuthConfig(enabled: boolean): [ConfigState, () => void] {
  const { apiFetch } = useSession();
  const [state, setState] = useState<ConfigState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    apiFetch('/auth/config')
      .then(async (response) => {
        if (!response.ok) throw new Error('auth config unavailable');
        const config = await readJson<AuthConfig>(response);
        if (!cancelled) setState({ status: 'ready', config });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, apiFetch, attempt]);

  const reload = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };
  return [state, reload];
}

export interface SignInPromptProps {
  /**
   * `inline` (default): a compact card next to an action (e.g. add to cart).
   * `screen`: the branded full sign-in screen for pages that need an account (cart, orders,
   * checkout, profile): benefits, trust line, one clear call to action, loading/error/retry.
   */
  variant?: 'inline' | 'screen';
}

/**
 * Shown where a signed-in user is required and there is no session:
 *
 * - inside the Mini App: the session could not be established, so offer a retry;
 * - in a browser: "Sign in with Telegram" (OIDC), but only when the API enables it;
 * - otherwise: ask the visitor to open the shop in Telegram.
 *
 * Browsing the catalog never needs this.
 */
export function SignInPrompt({ variant = 'inline' }: SignInPromptProps) {
  const { dict } = useI18n();
  const { status, error, retry } = useSession();
  const telegram = useTelegram();
  const inMiniApp = telegram.kind === 'telegram';
  const [config, reloadConfig] = useAuthConfig(!inMiniApp && status === 'anonymous');

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div role="status" aria-label={dict.auth.checking} className="flex flex-col gap-2">
        <Skeleton className={variant === 'screen' ? 'h-72 w-full rounded-3xl' : 'h-10 w-full'} />
      </div>
    );
  }

  let message: string;
  if (error?.code === 'account_blocked') message = dict.auth.accountBlocked;
  else if (error?.code === 'rate_limited') message = dict.auth.rateLimited;
  else if (error !== null && (error.isNetworkError || error.status >= 500)) {
    message = dict.auth.serviceUnavailable;
  } else if (!inMiniApp && config.status === 'failed') message = dict.auth.configFailed;
  else message = inMiniApp ? dict.auth.miniAppFailed : dict.auth.openInTelegram;

  const configLoading = !inMiniApp && status === 'anonymous' && config.status === 'loading';
  const telegramLoginEnabled =
    !inMiniApp &&
    status === 'anonymous' &&
    config.status === 'ready' &&
    config.config.telegram_oidc.enabled;
  const showRetry = inMiniApp || status === 'error' || (!inMiniApp && config.status === 'failed');
  const onRetry = () => {
    if (status === 'error' || inMiniApp) retry();
    else reloadConfig();
  };

  if (variant === 'inline') {
    return (
      <div className="flex flex-col items-start gap-3 rounded-3xl bg-surface p-4">
        {telegramLoginEnabled ? (
          <>
            <p className="font-semibold">{dict.auth.loginHeading}</p>
            <p className="text-muted-foreground">{dict.auth.loginHint}</p>
            <TelegramLoginButton />
          </>
        ) : (
          <p role="status">{message}</p>
        )}
        {showRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {dict.auth.retry}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="sign-in-title"
      data-testid="sign-in-screen"
      className="mm-enter relative isolate overflow-hidden rounded-3xl bg-surface p-5 sm:p-8"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 -z-10 h-28 bg-gradient-to-b from-brand-soft to-transparent"
      />
      <div className="flex flex-col items-start gap-5">
        <MuniraMark className="size-14 shrink-0" />
        <div className="flex flex-col gap-1">
          <h2 id="sign-in-title" className="text-2xl font-bold tracking-tight text-balance">
            {dict.auth.screenTitle}
          </h2>
          <p className="text-muted-foreground">{dict.auth.screenSubtitle}</p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {dict.auth.benefits.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink"
              >
                <CheckIcon width={12} height={12} />
              </span>
              <span className="min-w-0">{benefit}</span>
            </li>
          ))}
        </ul>
        <div className="flex w-full flex-col gap-3">
          {telegramLoginEnabled ? (
            <TelegramLoginButton />
          ) : configLoading ? (
            <Skeleton className="h-12 w-full max-w-72 rounded-xl" />
          ) : (
            <p role="status" className="font-medium">
              {message}
            </p>
          )}
          {showRetry ? (
            <Button variant="secondary" onClick={onRetry} className="self-start">
              {dict.auth.retry}
            </Button>
          ) : null}
        </div>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheckIcon width={18} height={18} aria-hidden="true" className="mt-px shrink-0" />
          <span>{dict.auth.trust}</span>
        </p>
      </div>
    </section>
  );
}
