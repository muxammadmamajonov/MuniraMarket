'use client';

import type { AuthConfig } from '@muniramarket/contracts';
import { Button, Skeleton } from '@muniramarket/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';
import { TelegramLoginButton } from './telegram-login-button';

type ConfigState =
  { status: 'loading' } | { status: 'ready'; config: AuthConfig } | { status: 'failed' };

/** `GET /auth/config`, fetched once, only while a plain-browser visitor needs to sign in. */
function useAuthConfig(enabled: boolean): ConfigState {
  const { apiFetch } = useSession();
  const [state, setState] = useState<ConfigState>({ status: 'loading' });

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
  }, [enabled, apiFetch]);

  return state;
}

/**
 * Shown where a signed-in user is required (cart actions) and there is no session:
 *
 * - inside the Mini App: the session could not be established, so offer a retry;
 * - in a browser: the Telegram Login Widget, but only when the API enables it;
 * - otherwise: ask the visitor to open the shop in Telegram.
 *
 * Browsing the catalog never needs this.
 */
export function SignInPrompt() {
  const { dict } = useI18n();
  const { status, error, retry } = useSession();
  const telegram = useTelegram();
  const inMiniApp = telegram.kind === 'telegram';
  const config = useAuthConfig(!inMiniApp && status === 'anonymous');

  if (status === 'loading' || status === 'authenticated') {
    return (
      <div role="status" aria-label={dict.auth.checking} className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  let message: string;
  if (error?.code === 'account_blocked') message = dict.auth.accountBlocked;
  else if (error?.code === 'rate_limited') message = dict.auth.rateLimited;
  else if (error !== null && (error.isNetworkError || error.status >= 500)) {
    message = dict.auth.serviceUnavailable;
  } else message = inMiniApp ? dict.auth.miniAppFailed : dict.auth.openInTelegram;

  const showRetry = inMiniApp || status === 'error';
  const widgetEnabled =
    !inMiniApp &&
    status === 'anonymous' &&
    config.status === 'ready' &&
    config.config.telegram_login_widget.enabled &&
    config.config.telegram_login_widget.bot_username !== null;

  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface p-4">
      {widgetEnabled && config.status === 'ready' ? (
        <>
          <p className="font-semibold">{dict.auth.loginHeading}</p>
          <p className="text-muted-foreground">{dict.auth.loginWidgetHint}</p>
          <TelegramLoginButton
            botUsername={config.config.telegram_login_widget.bot_username ?? ''}
          />
        </>
      ) : (
        <p role="status">{message}</p>
      )}
      {showRetry ? (
        <Button variant="secondary" onClick={retry}>
          {dict.auth.retry}
        </Button>
      ) : null}
    </div>
  );
}
