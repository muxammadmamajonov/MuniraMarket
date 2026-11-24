'use client';

import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';
import { useI18n } from '@/i18n/context';

/** Unknown admin URL (for example a mistyped path): a way back instead of a bare 404. */
export default function NotFound() {
  const { dict, locale } = useI18n();
  return (
    <main className="flex min-h-dvh flex-col justify-center p-4">
      <AuthCard title={dict.errors.notFoundTitle} description={dict.errors.notFoundMessage}>
        <Link href={`/${locale}`} className="font-semibold text-brand-ink underline">
          {dict.auth.callbackBack}
        </Link>
      </AuthCard>
    </main>
  );
}
