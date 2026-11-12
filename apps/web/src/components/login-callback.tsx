'use client';

import { parseTelegramOidcFailureStatus } from '@muniramarket/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/i18n/context';
import { PageContainer } from './page-container';
import { TelegramLoginButton } from './telegram-login-button';

/**
 * `/<locale>/auth/telegram`: where the Core API's OIDC callback sends the browser when "Sign in
 * with Telegram" did not complete (`?status=failed|cancelled|blocked|unavailable`). A successful
 * sign-in never lands here: the API redirects straight back to the page the user started from.
 *
 * Shows why, a link home and (unless the account is blocked) a new attempt that returns to the
 * cart. Unknown or missing statuses read as `failed`. The query is only used to pick a message.
 */
export function LoginCallback() {
  const { dict, locale } = useI18n();
  const params = useSearchParams();
  const status = parseTelegramOidcFailureStatus(params.get('status')) ?? 'failed';

  return (
    <PageContainer className="flex flex-col items-start gap-4 py-8">
      <h2 className="text-xl font-bold">{dict.auth.callbackTitle}</h2>
      <p role="alert">{dict.auth.callbackStatus[status]}</p>
      {status === 'blocked' ? null : <TelegramLoginButton returnTo={`/${locale}/cart`} />}
      <Link
        href={`/${locale}`}
        className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {dict.auth.callbackBack}
      </Link>
    </PageContainer>
  );
}
