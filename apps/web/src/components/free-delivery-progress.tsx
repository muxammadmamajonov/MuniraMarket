'use client';

import { formatUZS } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { CheckIcon, TruckIcon } from './icons';

export interface FreeDeliveryProgressProps {
  /** The zone's free-delivery threshold (`free_delivery_threshold_uzs`), > 0. */
  threshold: number;
  /** How much is still missing (the quote's `free_delivery_remaining_uzs`), 0 once reached. */
  remaining: number;
  testId?: string;
}

/**
 * How far the order is from free delivery, as a line of text and a thin bar. Shown only where the
 * delivery zone really has a threshold; the numbers are the zone's (and, at checkout, the
 * server quote's). The bar fills with `transform: scaleX`, so updates animate without layout
 * work; reduced motion makes it jump.
 */
export function FreeDeliveryProgress({ threshold, remaining, testId }: FreeDeliveryProgressProps) {
  const { dict, locale } = useI18n();
  const t = dict.checkout.summary;
  const reached = remaining <= 0;
  const progress = reached ? 1 : Math.min(1, Math.max(0, (threshold - remaining) / threshold));

  return (
    <div
      className="flex flex-col gap-2"
      data-reached={reached ? 'true' : undefined}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={`flex size-7 shrink-0 items-center justify-center rounded-full ${reached ? 'bg-primary text-primary-foreground' : 'bg-brand-soft text-brand-ink'}`}
        >
          {reached ? <CheckIcon width={16} height={16} /> : <TruckIcon width={16} height={16} />}
        </span>
        <span className="min-w-0">
          {reached
            ? t.freeReached
            : formatMessage(t.freeRemaining, { amount: formatUZS(remaining, locale) })}
        </span>
      </p>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full origin-left rounded-full bg-primary transition-transform duration-500 ease-out-strong motion-reduce:transition-none"
          style={{ transform: `scaleX(${String(progress)})` }}
        />
      </div>
    </div>
  );
}
