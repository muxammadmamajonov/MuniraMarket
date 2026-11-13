'use client';

import { Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';
import {
  ChevronRightIcon,
  GlobeIcon,
  HelpIcon,
  IdCardIcon,
  LogOutIcon,
  PinIcon,
  ReceiptIcon,
  TelegramIcon,
} from './icons';
import { SettingsButtonRow, SettingsGroup, SettingsLinkRow } from './profile/settings-list';
import { SignInPrompt } from './sign-in-prompt';
import { FOCUS_RING, GROUP } from './ui-classes';

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
 * The Profile tab: a settings hub in the native grouped-list style. Each row opens its own page
 * (with its title in the header slot and Telegram's BackButton):
 *
 * - the account card -> personal details (name, birthday, phone);
 * - My orders (filtered by status), My addresses (saved delivery addresses);
 * - Language (one setting shared with the bot), Help;
 * - in a browser, sign out. Inside the Mini App the Telegram account IS the session.
 *
 * Signed out, the branded sign-in screen comes first and only Language and Help remain.
 */
export function ProfileView() {
  const { dict, locale } = useI18n();
  const t = dict.account;
  const { status, user, logout } = useSession();
  const telegram = useTelegram();
  const [pending, setPending] = useState(false);
  const base = `/${locale}/profile`;

  const settings = (
    <SettingsGroup title={t.settingsSection} labelledBy="profile-settings">
      <SettingsLinkRow
        href={`${base}/language`}
        testId="profile-language-row"
        icon={<GlobeIcon />}
        tone="muted"
        title={t.languageLink}
        value={dict.language[locale]}
      />
    </SettingsGroup>
  );

  const support = (
    <SettingsGroup title={t.supportSection} labelledBy="profile-support">
      <SettingsLinkRow
        href={`/${locale}/help`}
        icon={<HelpIcon />}
        tone="muted"
        title={t.helpLink}
      />
    </SettingsGroup>
  );

  if (status === 'loading') {
    return (
      <div role="status" aria-label={dict.profile.checking} className="flex flex-col gap-6">
        <Skeleton className="h-[88px] w-full rounded-3xl bg-surface" />
        <Skeleton className="h-40 w-full rounded-3xl bg-surface" />
        <Skeleton className="h-14 w-full rounded-3xl bg-surface" />
      </div>
    );
  }

  if (status !== 'authenticated' || user === null) {
    return (
      <div data-testid="profile-anonymous" className="flex flex-col gap-6">
        <SignInPrompt variant="screen" />
        {settings}
        {support}
      </div>
    );
  }

  const fullName = [user.first_name, user.last_name ?? ''].join(' ').trim();

  return (
    <div data-testid="profile-authenticated" className="flex flex-col gap-6">
      <Link
        href={`${base}/personal`}
        aria-label={`${fullName}. ${t.personalLink}`}
        data-testid="profile-card"
        className={`${GROUP} flex items-center gap-4 p-4 transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-hover text-2xl font-bold text-primary-foreground shadow-[inset_0_-2px_0_rgb(0_0_0/0.12)]"
        >
          {initialOf(fullName)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-testid="profile-name"
            data-user-text
            className="line-clamp-2 text-xl leading-6 font-bold tracking-[-0.01em]"
          >
            {fullName}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[15px] text-muted-foreground">
            {user.phone_hint ? (
              <span data-money data-testid="profile-phone" className="truncate">
                {user.phone_hint}
              </span>
            ) : user.username ? (
              <>
                <TelegramIcon width={14} height={14} aria-hidden="true" className="shrink-0" />
                <span className="truncate">@{user.username}</span>
              </>
            ) : (
              <span className="truncate">{t.phoneMissing}</span>
            )}
          </span>
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          width={18}
          height={18}
          className="shrink-0 text-muted-foreground/70"
        />
      </Link>

      <SettingsGroup title={t.accountSection} labelledBy="profile-account">
        <SettingsLinkRow
          href={`${base}/personal`}
          testId="profile-personal-row"
          icon={<IdCardIcon />}
          tone="brand"
          title={t.personalLink}
        />
        <SettingsLinkRow
          href={`/${locale}/orders`}
          testId="profile-orders-row"
          icon={<ReceiptIcon />}
          tone="ink"
          title={t.ordersLink}
        />
        <SettingsLinkRow
          href={`${base}/addresses`}
          testId="profile-addresses-row"
          icon={<PinIcon />}
          tone="ink"
          title={t.addressesLink}
        />
      </SettingsGroup>

      {settings}
      {support}

      {telegram.kind === 'telegram' ? (
        <p className="px-4 text-center text-[13px] text-muted-foreground">
          {dict.profile.miniAppSession}
        </p>
      ) : (
        <SettingsGroup>
          <SettingsButtonRow
            onClick={() => {
              setPending(true);
              // A failed logout leaves the session in place; the row becomes usable again.
              void logout()
                .catch(() => undefined)
                .finally(() => setPending(false));
            }}
            disabled={pending}
            danger
            chevron={false}
            icon={<LogOutIcon />}
            tone="soft"
            title={t.logout}
          />
        </SettingsGroup>
      )}
    </div>
  );
}
