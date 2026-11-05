'use client';

import { Button, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';
import { ChevronRightIcon, GlobeIcon, ReceiptIcon } from './icons';
import { LanguageSwitcher } from './language-switcher';
import { SignInPrompt } from './sign-in-prompt';
import { CARD, FOCUS_RING, PRESS } from './ui-classes';

/** First user-perceived character (a whole emoji or accented letter), upper-cased. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  if (typeof Intl.Segmenter === 'function') {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(trimmed)
      [Symbol.iterator]()
      .next();
    if (first.done !== true) return first.value.segment.toLocaleUpperCase();
  }
  return (Array.from(trimmed)[0] ?? '').toLocaleUpperCase();
}

/**
 * The Profile tab, built only from the current session:
 *
 * - signed in: the name, a link to the orders and, in a browser, sign out (inside the Mini App the
 *   session is the Telegram account and comes back on every open, so there is nothing to sign out
 *   of; see `AccountMenu`);
 * - not signed in: why to sign in and the shared `SignInPrompt` (Telegram Login Widget in a
 *   browser when the API enables it, otherwise "open in Telegram", or a retry in the Mini App).
 *
 * The language switch is offered either way. Nothing else: no invented account features.
 */
export function ProfileView() {
  const { dict, locale } = useI18n();
  const t = dict.profile;
  const { status, user, logout } = useSession();
  const telegram = useTelegram();
  const [pending, setPending] = useState(false);

  const language = (
    <section aria-labelledby="profile-language" className={`${CARD} flex flex-col gap-3`}>
      <h2 id="profile-language" className="flex items-center gap-2 text-sm font-semibold">
        <GlobeIcon width={18} height={18} aria-hidden="true" className="text-muted-foreground" />
        {t.languageHeading}
      </h2>
      <LanguageSwitcher
        locale={locale}
        label={dict.language.label}
        names={{ uz: dict.language.uz, ru: dict.language.ru }}
      />
    </section>
  );

  if (status === 'loading') {
    return (
      <div role="status" aria-label={t.checking} className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (status !== 'authenticated' || user === null) {
    return (
      <div data-testid="profile-anonymous" className="flex flex-col gap-4">
        <section className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t.anonymousTitle}</h2>
          <p className="text-muted-foreground">{t.anonymousText}</p>
        </section>
        <SignInPrompt />
        {language}
      </div>
    );
  }

  const fullName = [user.first_name, user.last_name ?? ''].join(' ').trim();

  return (
    <div data-testid="profile-authenticated" className="flex flex-col gap-4">
      <section aria-label={t.accountHeading} className={`${CARD} flex items-center gap-3`}>
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-lg font-bold text-brand-ink"
        >
          {initialOf(fullName)}
        </span>
        <p
          data-testid="profile-name"
          data-user-text
          className="line-clamp-2 min-w-0 flex-1 text-lg font-semibold"
        >
          {fullName}
        </p>
      </section>

      <Link
        href={`/${locale}/orders`}
        className={`flex min-h-14 items-center gap-3 rounded-xl border border-border bg-surface px-4 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
      >
        <ReceiptIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium">{t.ordersLink}</span>
        <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </Link>

      {language}

      {telegram.kind === 'telegram' ? null : (
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            // A failed logout leaves the session in place; the button becomes usable again.
            void logout()
              .catch(() => undefined)
              .finally(() => setPending(false));
          }}
        >
          {dict.auth.logout}
        </Button>
      )}
    </div>
  );
}
