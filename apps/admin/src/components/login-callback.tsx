'use client';

import { parseTelegramOidcFailureStatus } from '@muniramarket/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/i18n/context';
import { parseSupportCode } from '@/lib/api/request-id';
import { AuthCard } from './auth-card';
import { TelegramLoginButton } from './telegram-login-button';
import { SupportCode } from './ui/support-code';

/**
 * `/<locale>/auth/telegram`: where the OIDC callback sends the browser when "Sign in with
 * Telegram" did not complete (`?status=failed|cancelled|blocked|unavailable`, from the Core API or
 * from the admin proxy when the API could not be reached, then with `&ref=<support code>`). A
 * successful sign-in never lands here: the API redirects straight to `/<locale>`, where the
 * back-office gate decides what the new session may see.
 *
 * - `cancelled`: the user declined on Telegram (denied);
 * - `failed`: the one-time sign-in state expired or did not verify (link opened twice, too late,
 *   another browser);
 * - `unavailable`: the service could not complete it (outage, rate limit, timeout);
 * - `blocked`: the account is blocked, so no new attempt is offered.
 *
 * Unknown or missing statuses read as `failed`. The query is only used to pick a message and to
 * show the support code, which must have the exact short shape.
 */
export function LoginCallback() {
  const { dict, locale } = useI18n();
  const params = useSearchParams();
  const status = parseTelegramOidcFailureStatus(params.get('status')) ?? 'failed';
  const supportCode = parseSupportCode(params.get('ref'));

  return (
    <div className="flex min-h-[70dvh] items-center px-4 py-10 sm:px-6">
      <AuthCard
        title={dict.auth.callbackTitle}
        tone="danger"
        description={<p role="alert">{dict.auth.callbackStatus[status]}</p>}
        testId="login-callback"
      >
        <SupportCode code={supportCode} hint />
        {status === 'blocked' ? null : <TelegramLoginButton label={dict.auth.tryAgain} />}
        <Link
          href={`/${locale}`}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-surface px-4 font-semibold transition-transform duration-150 ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.98]"
        >
          {dict.auth.callbackBack}
        </Link>
      </AuthCard>
    </div>
  );
}
