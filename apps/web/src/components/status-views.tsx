'use client';

import { EmptyState, ErrorState } from '@muniramarket/ui';
import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { PageContainer } from './page-container';
import { LINK_BUTTON_PRIMARY } from './ui-classes';

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
          <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
            {dict.errors.backHome}
          </Link>
        }
      />
    </PageContainer>
  );
}
