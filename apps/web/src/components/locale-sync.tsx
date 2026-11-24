'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useI18n } from '@/i18n/context';
import { persistLocale, switchLocalePath } from '@/i18n/switch-locale';
import { useSession } from '@/lib/session';

/**
 * Keeps the URL locale a view of the saved preference: once signed in, the account's language
 * (set in the bot's onboarding or in Profile) wins over whatever link was opened, and the
 * `locale` cookie is updated to match. Renders nothing; never writes the preference itself.
 */
export function LocaleSync() {
  const { locale } = useI18n();
  const { status, user } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const saved = status === 'authenticated' ? (user?.language ?? null) : null;

  useEffect(() => {
    if (saved === null || saved === locale) return;
    persistLocale(saved);
    router.replace(switchLocalePath(pathname, saved));
  }, [saved, locale, pathname, router]);

  return null;
}
