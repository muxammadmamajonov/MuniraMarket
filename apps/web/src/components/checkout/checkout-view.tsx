'use client';

import type { DistrictCode } from '@muniramarket/contracts';
import { EmptyState, ErrorState, Skeleton, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n/context';
import { dayLabel, slotWindow } from '@/lib/checkout/slots';
import { useCheckoutFlow, type FocusTarget } from '@/lib/checkout/use-checkout';
import { zoneForDistrict } from '@/lib/checkout/zones';
import { useHaptics, useMainButton, useTelegram } from '@/lib/telegram';
import { SignInPrompt } from '../sign-in-prompt';
import { LINK_BUTTON_PRIMARY } from '../ui-classes';
import { CheckoutFormFields } from './checkout-form';
import { DeliverySlotPicker } from './delivery-slot-picker';
import { FailureNotice } from './failure-notice';
import { OrderSummary } from './order-summary';
import { SubmitBar } from './submit-bar';

/** Room under the form for the browser's sticky submit bar (button row + safe-area inset). */
const BAR_CLEARANCE = 'pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]';
/** Same, when the bar also carries a reason line (up to two lines at 320px, plus the gap). */
const BAR_CLEARANCE_WITH_REASON = 'pb-[calc(9.5rem+env(safe-area-inset-bottom,0px))]';

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

  const focusField = useCallback((field: FocusTarget) => {
    // Deferred: while an order is being sent the fields are disabled and cannot take focus yet.
    setTimeout(() => {
      // The delivery-slot radio group is found by its `data-field` (only the shown day's group
      // has one; the radios of the other days are hidden and cannot take focus); every other
      // field by name.
      const element =
        formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`) ??
        formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`);
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
  const slotMissing = flow.slots.missing;
  const mainButtonDisabled =
    submitting || cooldown > 0 || !flow.formValid || readyQuote === null || blocked || slotMissing;
  // Browser: the button stays tappable so that tapping it reveals what is missing.
  // A missing delivery time is the one thing a tap cannot reveal better than the picker already
  // does, so the button is disabled and says why.
  const barDisabled = submitting || cooldown > 0 || blocked || slotMissing;
  const slotReason = slotMissing ? dict.checkout.slots.hintRequired : null;

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
  const { view: slotView, selected: selectedSlot, today } = flow.slots;
  const slotText =
    selectedSlot === null
      ? null
      : `${dayLabel(selectedSlot.date, today, dict.checkout.slots).text} · ${slotWindow(selectedSlot)}`;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void flow.submit();
      }}
      aria-label={dict.checkout.title}
      className={`grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start ${inTelegram ? '' : slotReason === null ? BAR_CLEARANCE : BAR_CLEARANCE_WITH_REASON}`}
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
        slotPicker={
          slotView === null ? null : (
            <DeliverySlotPicker
              slots={slotView.slots}
              selectedId={flow.slots.selectedId}
              required={slotView.required}
              disabled={submitting}
              stale={slotView.stale}
              notice={flow.slots.notice}
              onSelect={flow.slots.select}
              onClear={flow.slots.clear}
              today={today}
            />
          )
        }
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
        <OrderSummary cart={load.cart} quote={quote} readyQuote={readyQuote} slotText={slotText} />
        {inTelegram && !flow.formValid ? (
          <p className="text-sm text-muted-foreground" data-testid="fix-fields">
            {dict.checkout.summary.fixFields}
          </p>
        ) : null}
        {inTelegram && slotReason !== null ? (
          <p className="text-sm font-medium" data-testid="slot-reason">
            {slotReason}
          </p>
        ) : null}
      </div>

      {inTelegram ? null : (
        <SubmitBar
          total={totalText}
          label={action}
          busy={submitting}
          disabled={barDisabled}
          reason={slotReason}
        />
      )}
    </form>
  );
}
