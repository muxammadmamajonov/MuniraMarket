'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { EmptyPanel } from './empty-panel';
import { BasketIcon, HelpIcon } from './icons';
import { PageContainer } from './page-container';
import { LINK_BUTTON_PRIMARY } from './ui-classes';

/** Body of `error.tsx`: localized message with a retry button. */
export function ErrorView({ onRetry }: { onRetry: () => void }) {
  const { dict } = useI18n();
  return (
    <PageContainer>
      <div role="alert">
        <EmptyPanel
          icon={<HelpIcon />}
          title={dict.errors.title}
          description={dict.errors.message}
          action={
            <button type="button" onClick={onRetry} className={LINK_BUTTON_PRIMARY}>
              {dict.errors.retry}
            </button>
          }
        />
      </div>
    </PageContainer>
  );
}

/** Body of `not-found.tsx`. */
export function NotFoundView() {
  const { dict, locale } = useI18n();
  return (
    <PageContainer>
      <EmptyPanel
        icon={<BasketIcon />}
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
