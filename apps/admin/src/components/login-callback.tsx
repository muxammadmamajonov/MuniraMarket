'use client';

import { parseTelegramOidcFailureStatus } from '@muniramarket/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/i18n/context';
import { TelegramLoginButton } from './telegram-login-button';

/**
 * `/<locale>/auth/telegram`: where the Core API's OIDC callback sends the browser when "Sign in
 * with Telegram" did not complete (`?status=failed|cancelled|blocked|unavailable`). A successful
 * sign-in never lands here: the API redirects straight to `/<locale>`, where the back-office gate
 * decides what the new session may see.
 *
 * Shows why, a link back and (unless the account is blocked) a new attempt. Unknown or missing
 * statuses read as `failed`. The query is only used to pick a message.
 */
export function LoginCallback() {
  const { dict, locale } = useI18n();
  const params = useSearchParams();
  const status = parseTelegramOidcFailureStatus(params.get('status')) ?? 'failed';

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-start gap-4 px-4 py-12 sm:px-6">
      <h1 className="text-xl font-bold">{dict.auth.callbackTitle}</h1>
      <p role="alert">{dict.auth.callbackStatus[status]}</p>
      {status === 'blocked' ? null : <TelegramLoginButton />}
      <Link
        href={`/${locale}`}
        className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {dict.auth.callbackBack}
      </Link>
    </div>
  );
}
