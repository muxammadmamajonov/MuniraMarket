import { Suspense } from 'react';
import { LoginCallback } from '@/components/login-callback';

/** Landing page of the Telegram Login Widget redirect (`data-auth-url`). Never indexed. */
export const metadata = { robots: { index: false, follow: false } };

export default function TelegramLoginCallbackPage() {
  return (
    <main className="flex-1">
      {/* `useSearchParams` needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <LoginCallback />
      </Suspense>
    </main>
  );
}
