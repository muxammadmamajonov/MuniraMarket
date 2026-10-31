'use client';

import type { TelegramLoginWidgetPayload } from '@muniramarket/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { consumeLoginState } from '@/lib/auth/login-state';
import { useSession } from '@/lib/session';

/**
 * Builds the login payload from the redirect query. Only the documented widget fields are taken,
 * and numeric ones must be integers; anything else is ignored. The server verifies the HMAC.
 */
export function payloadFromSearchParams(
  params: URLSearchParams,
): TelegramLoginWidgetPayload | null {
  const id = Number(params.get('id'));
  const authDate = Number(params.get('auth_date'));
  const firstName = params.get('first_name');
  const hash = params.get('hash');
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(authDate)) return null;
  if (firstName === null || hash === null || hash === '') return null;

  const payload: TelegramLoginWidgetPayload = {
    id,
    first_name: firstName,
    auth_date: authDate,
    hash,
  };
  const lastName = params.get('last_name');
  const username = params.get('username');
  const photoUrl = params.get('photo_url');
  if (lastName !== null) payload.last_name = lastName;
  if (username !== null) payload.username = username;
  if (photoUrl !== null) payload.photo_url = photoUrl;
  return payload;
}

/**
 * Landing page of the Telegram Login Widget redirect: posts the signed fields to the API once,
 * then continues to the orders list (where the gate decides what the new session may see). The
 * redirect must carry the `state` this tab issued when it showed the widget; otherwise nothing is
 * sent (login CSRF, see `lib/auth/login-state.ts`).
 */
export function LoginCallback() {
  const { dict, locale } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const { loginWithWidget } = useSession();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const stateOk = consumeLoginState(params.get('state'));
    const payload = payloadFromSearchParams(params);
    if (!stateOk || payload === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    loginWithWidget(payload)
      .then(() => router.replace(`/${locale}`))
      .catch(() => setFailed(true));
  }, [params, loginWithWidget, router, locale]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-start gap-4 px-4 py-12 sm:px-6">
      {failed ? (
        <>
          <p role="alert">{dict.auth.callbackFailed}</p>
          <Link
            href={`/${locale}`}
            className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-muted"
          >
            {dict.auth.callbackBack}
          </Link>
        </>
      ) : (
        <p role="status">{dict.auth.callbackSigningIn}</p>
      )}
    </div>
  );
}
