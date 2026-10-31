'use client';

import { Button } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

export interface SubmitBarProps {
  /** Formatted total, or `null` before a quote exists. */
  total: string | null;
  label: string;
  busy: boolean;
  disabled: boolean;
  /** Why the button is disabled, when the customer can fix it (for example no delivery time). */
  reason?: string | null;
}

/**
 * The browser's submit control (a submit button of the checkout form): pinned to the bottom edge, padded by the safe-area inset (home
 * indicator), with the total beside the button. The total never truncates; when it and the button
 * do not fit side by side (320px, very large totals) the button wraps onto its own line.
 *
 * Inside Telegram this is not rendered: the native MainButton is the submit control there.
 */
export function SubmitBar({ total, label, busy, disabled, reason = null }: SubmitBarProps) {
  const { dict } = useI18n();
  return (
    <div
      data-testid="submit-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        {reason === null ? null : (
          <p id="submit-reason" data-testid="submit-reason" className="w-full text-sm font-medium">
            {reason}
          </p>
        )}
        {total === null ? null : (
          <p className="flex shrink-0 flex-col leading-tight">
            <span className="text-sm text-muted-foreground">{dict.checkout.summary.total}</span>
            <span data-money data-testid="bar-total" className="text-lg font-bold">
              {total}
            </span>
          </p>
        )}
        <Button
          type="submit"
          size="lg"
          disabled={disabled}
          aria-busy={busy}
          aria-describedby={reason === null ? undefined : 'submit-reason'}
          className="min-w-0 grow basis-44"
        >
          {busy ? dict.checkout.placing : label}
        </Button>
      </div>
    </div>
  );
}
