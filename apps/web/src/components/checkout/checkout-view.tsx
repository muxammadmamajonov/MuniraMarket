'use client';

import type { DistrictCode } from '@muniramarket/contracts';
import { EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n/context';
import { useCheckoutFlow } from '@/lib/checkout/use-checkout';
import { zoneForDistrict } from '@/lib/checkout/zones';
import { useHaptics, useMainButton, useTelegram } from '@/lib/telegram';
import { SignInPrompt } from '../sign-in-prompt';
import { LINK_BUTTON_PRIMARY } from '../ui-classes';
import { CheckoutFormFields } from './checkout-form';
import { FailureNotice } from './failure-notice';
import { OrderSummary } from './order-summary';
import { SubmitBar } from './submit-bar';

/** Room under the form for the browser's sticky submit bar (button row + safe-area inset). */
const BAR_CLEARANCE = 'pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]';

function CheckoutSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * The checkout page body: delivery details, recipient, payment, an order summary priced by the
 * server, and the submit control (Telegram MainButton inside the Mini App, a sticky bar in a
 * browser).
 */
export function CheckoutView() {
  const { dict, locale } = useI18n();
  const router = useRouter();
  const telegram = useTelegram();
  const { notify } = useHaptics();
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const inTelegram = telegram.kind === 'telegram';

  const focusField = useCallback((field: string) => {
    // Deferred: while an order is being sent the fields are disabled and cannot take focus yet.
    setTimeout(() => {
      const element = formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`);
      if (element === null || element === undefined) return;
      element.focus({ preventScroll: true });
      // Not in every test DOM; the browser always has it.
      if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
    }, 0);
  }, []);

  const onPlaced = useCallback(
    (order: { id: string }) => {
      router.replace(`/${locale}/orders/${encodeURIComponent(order.id)}?placed=1`);
    },
    [router, locale],
  );
  const onSuccess = useCallback(() => notify('success'), [notify]);
  const onError = useCallback(() => notify('error'), [notify]);

  const flow = useCheckoutFlow({ onPlaced, onSuccess, onError, focusField });
  const { load, values, quote, readyQuote, priceChange, failure, submitting, cooldown } = flow;

  // Bring a new notice into view (it sits above the summary, below the fields).
  useEffect(() => {
    if (failure === null && priceChange === null) return;
    const notice = noticeRef.current;
    if (notice !== null && typeof notice.scrollIntoView === 'function') {
      notice.scrollIntoView({ block: 'nearest' });
    }
  }, [failure, priceChange]);

  const ready = load.kind === 'ready' && load.cart.items.length > 0 && load.zones.length > 0;
  const total =
    priceChange !== null ? priceChange.to : readyQuote === null ? null : readyQuote.total_uzs;
  const totalText = total === null ? null : formatUZS(total, locale);
  // The MainButton has no room for a separate total, so its text carries it. The browser's bar
  // shows the total beside the button instead, and the button keeps a short label.
  const action = priceChange !== null ? dict.checkout.confirmNewTotal : dict.checkout.submit;
  const mainButtonText = totalText === null ? action : `${action} — ${totalText}`;

  const blocked = readyQuote !== null && !readyQuote.can_place_order && priceChange === null;
  // Telegram: the MainButton cannot be tapped to reveal errors, so it stays disabled until the
  // form is valid and the server says the order can be placed.
  const mainButtonDisabled =
    submitting || cooldown > 0 || !flow.formValid || readyQuote === null || blocked;
  // Browser: the button stays tappable so that tapping it reveals what is missing.
  const barDisabled = submitting || cooldown > 0 || blocked;

  useMainButton(
    ready && inTelegram
      ? {
          text: mainButtonText,
          onClick: () => void flow.submit(),
          disabled: mainButtonDisabled,
          loading: submitting,
        }
      : null,
  );

  if (flow.status !== 'authenticated') {
    return flow.status === 'loading' ? (
      <CheckoutSkeleton label={dict.checkout.loading} />
    ) : (
      <SignInPrompt />
    );
  }
  if (load.kind === 'loading') return <CheckoutSkeleton label={dict.checkout.loading} />;
  if (load.kind === 'failed') {
    return (
      <ErrorState
        title={dict.checkout.loadFailed}
        retryLabel={dict.checkout.retry}
        onRetry={() => void flow.reload()}
      />
    );
  }
  if (load.cart.items.length === 0) {
    return (
      <EmptyState
        title={dict.checkout.emptyTitle}
        description={dict.checkout.emptyHint}
        action={
          <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
            {dict.checkout.toCatalog}
          </Link>
        }
      />
    );
  }
  if (load.zones.length === 0) {
    return (
      <ErrorState
        title={dict.checkout.noZones}
        retryLabel={dict.checkout.retry}
        onRetry={() => void flow.reload()}
      />
    );
  }

  const selectedZone = readyQuote?.zone ?? zoneForDistrict(load.zones, values.district);

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void flow.submit();
      }}
      aria-label={dict.checkout.title}
      className={`grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start ${inTelegram ? '' : BAR_CLEARANCE}`}
    >
      <CheckoutFormFields
        values={values}
        errors={flow.errors}
        zones={load.zones}
        selectedZone={selectedZone}
        disabled={submitting}
        onChange={flow.setField}
        onDistrict={(district: DistrictCode | '') => flow.setDistrict(district)}
        onBlur={flow.touch}
      />

      <div className="flex min-w-0 flex-col gap-4 md:sticky md:top-4">
        <FailureNotice
          ref={noticeRef}
          failure={failure}
          priceChange={priceChange}
          cooldown={cooldown}
          busy={submitting}
          onRetry={() => void flow.submit()}
          onConfirmPrice={() => void flow.submit()}
        />
        <OrderSummary cart={load.cart} quote={quote} readyQuote={readyQuote} />
        {inTelegram && !flow.formValid ? (
          <p className="text-sm text-muted-foreground" data-testid="fix-fields">
            {dict.checkout.summary.fixFields}
          </p>
        ) : null}
      </div>

      {inTelegram ? null : (
        <SubmitBar total={totalText} label={action} busy={submitting} disabled={barDisabled} />
      )}
    </form>
  );
}
