'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useEffect } from 'react';
import { ErrorView } from '@/components/status-views';

/**
 * Error boundary for every page under a locale (for example when the Core API is unreachable).
 * Details are never shown: in production Next replaces the message with a digest anyway.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Server-side details are logged by Next; this records only the opaque digest.
    console.error('Page error', error.digest ?? '');
  }, [error]);

  return (
    <main className="flex-1">
      <ErrorView
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
