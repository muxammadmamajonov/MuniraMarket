'use client';

import { SUPPORTED_LOCALES, type Locale, type UserPublic } from '@muniramarket/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { useI18n } from '@/i18n/context';
import { persistLocale, switchLocalePath } from '@/i18n/switch-locale';
import { readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { CheckIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

/**
 * The ONE place to change the language. Signed in, it is saved as the account's language
 * (`PUT /me/language`, the same value the bot uses); the URL then follows it. A visitor without
 * an account only has the browser: the choice goes to the `locale` cookie. Either way the URL
 * prefix is just the visible form of the saved value.
 */
export function LanguageSetting() {
  const { dict, locale } = useI18n();
  const { status, apiFetch, applyUser } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState<Locale | null>(null);
  const hintId = useId();

  async function choose(target: Locale) {
    if (target === locale || saving !== null) return;
    setFailed(false);
    if (status === 'authenticated') {
      setSaving(target);
      try {
        const response = await apiFetch('/me/language', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: target }),
        });
        if (!response.ok) throw new Error('language not saved');
        applyUser((await readJson<{ user: UserPublic }>(response)).user);
      } catch {
        setSaving(null);
        setFailed(true);
        return;
      }
    }
    persistLocale(target);
    startTransition(() => router.replace(switchLocalePath(pathname, target)));
  }

  const busy = saving !== null || pending;

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={dict.language.label}
        aria-describedby={hintId}
        aria-busy={busy}
        className="grid grid-cols-2 gap-1 rounded-2xl bg-surface-muted p-1"
      >
        {SUPPORTED_LOCALES.map((target) => {
          const active = target === locale;
          return (
            <button
              key={target}
              type="button"
              role="radio"
              aria-checked={active}
              lang={target}
              disabled={busy && !active}
              onClick={() => void choose(target)}
              className={
                `flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl px-3 text-base font-semibold ${PRESS} ${FOCUS_RING} ` +
                (active
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground disabled:opacity-60')
              }
            >
              {active ? <CheckIcon width={16} height={16} aria-hidden="true" /> : null}
              <span className="truncate">{dict.language[target]}</span>
            </button>
          );
        })}
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {dict.profile.languageHint}
      </p>
      {failed ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {dict.profile.languageFailed}
        </p>
      ) : null}
    </div>
  );
}
