'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useEffect } from 'react';
import { AuthErrorCard } from '@/components/auth-card';
import { useI18n } from '@/i18n/context';

/**
 * Error boundary for every admin page (for example when the Core API is unreachable during a
 * server render). Details are never shown: the opaque digest doubles as the support code.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const { dict } = useI18n();

  useEffect(() => {
    console.error('Page error', error.digest ?? '');
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col justify-center p-4">
      <AuthErrorCard
        title={dict.errors.title}
        description={dict.errors.message}
        supportCode={error.digest ?? null}
        retryLabel={dict.errors.retry}
        onRetry={() => {
          // Re-run the server render, then clear the boundary once fresh data has arrived.
          startTransition(() => {
            router.refresh();
            reset();
          });
        }}
      />
    </main>
  );
}
