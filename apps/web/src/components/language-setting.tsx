'use client';

import { SUPPORTED_LOCALES, type Locale, type UserPublic } from '@muniramarket/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { useI18n } from '@/i18n/context';
import { persistLocale, switchLocalePath } from '@/i18n/switch-locale';
import { readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';
import { CheckIcon } from './icons';
import { FOCUS_RING } from './ui-classes';

/**
 * The ONE place to change the language (the Profile › Language page): a native checkmark list. Signed in, it is saved as the account's language
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
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label={dict.language.label}
        aria-describedby={hintId}
        aria-busy={busy}
        className="flex flex-col overflow-hidden rounded-3xl bg-surface"
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
              data-testid={`language-option-${target}`}
              onClick={() => void choose(target)}
              className={
                'relative flex min-h-13 w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] ' +
                'before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-hairline first:before:hidden ' +
                `transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted disabled:opacity-60 ${FOCUS_RING} focus-visible:-outline-offset-2`
              }
            >
              <span className="min-w-0 flex-1 truncate">{dict.language[target]}</span>
              {saving === target ? (
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-reduce:animate-none"
                />
              ) : active ? (
                <CheckIcon
                  width={20}
                  height={20}
                  aria-hidden="true"
                  className="shrink-0 text-primary"
                  strokeWidth={2.5}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <p id={hintId} className="px-4 text-[13px] leading-[18px] text-muted-foreground">
        {dict.profile.languageHint}
      </p>
      {failed ? (
        <p role="alert" className="px-4 text-sm font-medium text-danger">
          {dict.profile.languageFailed}
        </p>
      ) : null}
    </div>
  );
}
