'use client';

import { Button, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';
import { ChevronRightIcon, GlobeIcon, HelpIcon, ReceiptIcon, TelegramIcon } from './icons';
import { LanguageSetting } from './language-setting';
import { PhoneCard } from './phone-card';
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

function NavRow({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold">{title}</span>
        <span className="truncate text-sm text-muted-foreground">{hint}</span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Link>
  );
}

/**
 * The Profile tab, built only from the current session:
 *
 * - signed in: who you are (Telegram account), the verified phone (share / update through
 *   Telegram), shortcuts to orders and help, and the language — the one place it is changed.
 *   In a browser there is also "sign out"; inside the Mini App the Telegram account IS the
 *   session, so there is nothing to sign out of.
 * - not signed in: the branded sign-in screen, plus the language (kept in the browser).
 *
 * Nothing else: no invented account features.
 */
export function ProfileView() {
  const { dict, locale } = useI18n();
  const t = dict.profile;
  const { status, user, logout } = useSession();
  const telegram = useTelegram();
  const [pending, setPending] = useState(false);

  const language = (
    <section aria-labelledby="profile-language" className={`${CARD} flex flex-col gap-3`}>
      <h2 id="profile-language" className="flex items-center gap-2 font-semibold">
        <GlobeIcon width={18} height={18} aria-hidden="true" className="text-muted-foreground" />
        {t.languageHeading}
      </h2>
      <LanguageSetting />
    </section>
  );

  const help = (
    <nav
      aria-label={t.settingsHeading}
      className="overflow-hidden rounded-xl border border-border bg-surface"
    >
      <NavRow
        href={`/${locale}/help`}
        icon={<HelpIcon width={20} height={20} />}
        title={t.helpLink}
        hint={t.helpHint}
      />
    </nav>
  );

  if (status === 'loading') {
    return (
      <div role="status" aria-label={t.checking} className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  if (status !== 'authenticated' || user === null) {
    return (
      <div data-testid="profile-anonymous" className="flex flex-col gap-4">
        <SignInPrompt variant="screen" />
        {language}
        {help}
      </div>
    );
  }

  const fullName = [user.first_name, user.last_name ?? ''].join(' ').trim();

  return (
    <div data-testid="profile-authenticated" className="flex flex-col gap-4">
      <section
        aria-label={t.accountHeading}
        className="relative isolate flex items-center gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4"
      >
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 -z-10 w-40 bg-gradient-to-r from-brand-soft to-transparent"
        />
        <span
          aria-hidden="true"
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground"
        >
          {initialOf(fullName)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            data-testid="profile-name"
            data-user-text
            className="line-clamp-2 text-lg font-bold leading-tight"
          >
            {fullName}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <TelegramIcon width={14} height={14} aria-hidden="true" className="shrink-0" />
            <span className="truncate">
              {user.username ? `@${user.username}` : t.telegramAccount}
            </span>
          </p>
        </div>
      </section>

      <PhoneCard />

      <nav
        aria-label={t.accountHeading}
        className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface"
      >
        <NavRow
          href={`/${locale}/orders`}
          icon={<ReceiptIcon width={20} height={20} />}
          title={t.ordersLink}
          hint={t.ordersHint}
        />
        <NavRow
          href={`/${locale}/help`}
          icon={<HelpIcon width={20} height={20} />}
          title={t.helpLink}
          hint={t.helpHint}
        />
      </nav>

      {language}

      {telegram.kind === 'telegram' ? (
        <p className="text-center text-sm text-muted-foreground">{t.miniAppSession}</p>
      ) : (
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
