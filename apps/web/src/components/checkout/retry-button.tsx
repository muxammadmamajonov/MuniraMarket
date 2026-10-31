'use client';

import { Button } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';

export interface RetryButtonProps {
  /** Seconds left of a rate-limit wait; 0 when there is none (the button is then usable). */
  cooldown: number;
  /** Disabled for another reason too (a request is in flight). */
  busy?: boolean;
  onClick: () => void;
  testId?: string;
}

/**
 * "Try again", disabled while a rate-limit wait runs. The countdown is visible but hidden from
 * assistive technology: the button's accessible name stays "Try again", so the live region around
 * it does not announce a new number every second. The wait itself is announced once, by the
 * message above it.
 */
export function RetryButton({ cooldown, busy = false, onClick, testId }: RetryButtonProps) {
  const { dict } = useI18n();
  const f = dict.checkout.failures;
  const waiting = cooldown > 0;
  return (
    <Button
      variant="secondary"
      disabled={busy || waiting}
      onClick={onClick}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {f.retry}
      {waiting ? (
        <span aria-hidden="true" data-money>
          {formatMessage(f.retryCountdown, { seconds: cooldown })}
        </span>
      ) : null}
    </Button>
  );
}
