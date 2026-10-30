'use client';

import { EmptyState, ErrorState } from '@muniramarket/ui';
import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { PageContainer } from './page-container';

/** Body of `error.tsx`: localized message with a retry button. */
export function ErrorView({ onRetry }: { onRetry: () => void }) {
  const { dict } = useI18n();
  return (
    <PageContainer>
      <ErrorState
        title={dict.errors.title}
        description={dict.errors.message}
        retryLabel={dict.errors.retry}
        onRetry={onRetry}
      />
    </PageContainer>
  );
}

/** Body of `not-found.tsx`. */
export function NotFoundView() {
  const { dict, locale } = useI18n();
  return (
    <PageContainer>
      <EmptyState
        title={dict.errors.notFoundTitle}
        description={dict.errors.notFoundMessage}
        action={
          <Link
            href={`/${locale}`}
            className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            {dict.errors.backHome}
          </Link>
        }
      />
    </PageContainer>
  );
}
