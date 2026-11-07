'use client';

import { Button } from '@muniramarket/ui';
import { useEffect, useId, useState } from 'react';
import { useI18n } from '@/i18n/context';
import type { Dictionary } from '@/i18n/dictionaries/types';
import { ApiRequestError } from '@/lib/api/errors';
import { navigateTo } from '@/lib/auth/navigate';
import { useSession } from '@/lib/session';
import { Spinner } from './ui/spinner';
import { SupportCode } from './ui/support-code';

/** Path (below the locale) the API sends the browser to when sign-in did not complete. */
export const LOGIN_CALLBACK_PATH = 'auth/telegram';

function startErrorMessage(dict: Dictionary, error: unknown): string {
  if (!(error instanceof ApiRequestError)) return dict.auth.loginStartFailed;
  if (error.code === 'rate_limited') return dict.auth.rateLimited;
  if (error.code === 'feature_disabled') return dict.auth.notConfiguredMessage;
  if (error.isNetworkError || error.status >= 500) return dict.auth.serviceUnavailable;
  return dict.auth.loginStartFailed;
}

interface StartError {
  message: string;
  supportCode: string | null;
}

/**
 * "Sign in with Telegram". The whole OIDC flow runs on the Core API: this button asks it to start
 * (`POST /auth/telegram/oidc/start`, which also sets a short-lived binding cookie) and then sends
 * the browser to Telegram with a full top-level navigation, never a popup or `fetch`. Telegram
 * returns to the API's callback on this origin, which redirects to `/<locale>` signed in (the
 * back-office gate then decides what the session may see), or to
 * `/<locale>/auth/telegram?status=...` when it did not work.
 *
 * While starting, the button shows a spinner and stays busy (the page is about to be replaced).
 * When the start fails it says why, shows the support code of the failed request, and the same
 * button becomes "Try again".
 *
 * Nothing from Telegram is loaded into our pages (no script, no iframe).
 */
export function TelegramLoginButton({ label }: { label?: string }) {
  const { dict, locale } = useI18n();
  const { startTelegramLogin } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StartError | null>(null);
  const errorId = useId();

  // Coming back from Telegram with the Back button can restore this page from the bfcache with
  // the button still busy; make it usable again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await startTelegramLogin(`/${locale}`);
      // Stay busy: the page is about to be replaced by Telegram's.
      navigateTo(url);
    } catch (cause) {
      setBusy(false);
      setError({
        message: startErrorMessage(dict, cause),
        supportCode: cause instanceof ApiRequestError ? cause.supportCode : null,
      });
    }
  }

  const idleLabel = error === null ? (label ?? dict.auth.loginButton) : dict.auth.tryAgain;

  return (
    <div className="flex w-full flex-col items-stretch gap-3">
      <Button
        size="lg"
        onClick={() => void start()}
        aria-busy={busy}
        aria-disabled={busy}
        aria-describedby={error === null ? undefined : errorId}
        data-testid="telegram-login-button"
        className="w-full"
      >
        {busy ? <Spinner /> : <TelegramIcon />}
        <span className="min-w-0 break-words">{busy ? dict.auth.loginStarting : idleLabel}</span>
      </Button>
      {error === null ? null : (
        <div
          id={errorId}
          role="alert"
          data-testid="login-error"
          className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3 text-left"
        >
          <p className="flex items-start gap-2 text-sm font-medium text-danger">
            <AlertIcon />
            <span className="min-w-0 break-words">{error.message}</span>
          </p>
          <SupportCode code={error.supportCode} hint />
        </div>
      )}
    </div>
  );
}

function TelegramIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="size-5 shrink-0">
      <path
        fill="currentColor"
        d="M21.94 4.3a1.1 1.1 0 0 0-1.5-1.18L2.7 10.03c-.98.38-.97 1.77.02 2.13l4.48 1.63 1.7 5.4c.24.77 1.2 1.03 1.79.47l2.5-2.38 4.6 3.4c.66.48 1.6.11 1.77-.69l2.38-15.69ZM9.6 14.07l8.08-7.2-6.47 8.2-.3 2.94-1.31-3.94Z"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 size-4 shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </svg>
  );
}
