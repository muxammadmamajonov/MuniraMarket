'use client';

import type {
  Cart,
  CheckoutQuote,
  DeliveryZone,
  DistrictCode,
  OrderDetail,
} from '@muniramarket/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCart } from '@/lib/api/cart';
import { getDeliveryZones } from '@/lib/api/delivery';
import { ApiRequestError } from '@/lib/api/errors';
import { createOrder, quoteCheckout } from '@/lib/api/orders';
import { useSession } from '@/lib/session';
import { classifyCheckoutError, type CheckoutFailure, type SlotFailureReason } from './failures';
import {
  buildOrderRequest,
  clampChars,
  emptyFormValues,
  firstInvalidField,
  LIMITS,
  requestFingerprint,
  validateForm,
  type CheckoutFormValues,
  type FieldName,
  type FormErrors,
} from './form';
import { useSubmissionController } from './idempotency';
import { bookableSlot, todayInTashkent } from './slots';
import { zoneForDistrict } from './zones';

/** A quote older than this is re-fetched before the order is placed (prices and stock move). */
export const QUOTE_MAX_AGE_MS = 60_000;

export type CheckoutLoad =
  { kind: 'loading' } | { kind: 'ready'; cart: Cart; zones: DeliveryZone[] } | { kind: 'failed' };

export type QuoteState =
  | { kind: 'idle' }
  /** `previous` is the last quote that arrived, so the slot picker can stay put while re-quoting. */
  | { kind: 'loading'; district: DistrictCode; previous: CheckoutQuote | null }
  | { kind: 'ready'; district: DistrictCode; quote: CheckoutQuote; fetchedAt: number }
  | { kind: 'failed'; district: DistrictCode; failure: CheckoutFailure };

/** The customer confirmed `from`; the server would now charge `to`. Needs an explicit confirm. */
export interface PriceChange {
  from: number;
  to: number;
}

/** A form field, or the delivery-slot group (which is not a form field of its own). */
export type FocusTarget = FieldName | 'deliverySlot';

export interface CheckoutFlowOptions {
  /** Called after the order exists, with the created order. */
  onPlaced: (order: OrderDetail) => void;
  /** Haptic hooks, injected so the flow itself stays free of Telegram specifics. */
  onSuccess?: () => void;
  onError?: () => void;
  /** Moves focus to a form field (the view owns the DOM). */
  focusField?: (field: FocusTarget) => void;
}

function displayName(user: { first_name: string; last_name: string | null } | null): string {
  if (user === null) return '';
  return clampChars(`${user.first_name} ${user.last_name ?? ''}`.trim(), LIMITS.recipientName.max);
}

/**
 * State machine behind the checkout page: loads the cart and delivery zones, prices the cart per
 * district, and places the order with idempotency and double-submit protection.
 */
export function useCheckoutFlow({ onPlaced, onSuccess, onError, focusField }: CheckoutFlowOptions) {
  const { status, user, apiFetch, retry } = useSession();
  const controller = useSubmissionController();

  const [load, setLoad] = useState<CheckoutLoad>({ kind: 'loading' });
  const [values, setValues] = useState<CheckoutFormValues>(emptyFormValues);
  const [prefilled, setPrefilled] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<FieldName, true>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FormErrors>({});
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' });
  const [priceChange, setPriceChange] = useState<PriceChange | null>(null);
  const [failure, setFailure] = useState<CheckoutFailure | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [slotNotice, setSlotNotice] = useState<SlotFailureReason | null>(null);
  // The day "Today" means for the windows on screen: Tashkent's date when the quote arrived
  // (read in a callback, never while rendering).
  const [today, setToday] = useState(() => todayInTashkent());
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const quoteSeq = useRef(0);
  const lastQuote = useRef<CheckoutQuote | null>(null);

  // Prefill the recipient's name once, from the signed-in user (adjusting state while rendering is
  // the supported way to derive state from a value that arrives later).
  if (!prefilled && user !== null) {
    setPrefilled(true);
    const name = displayName(user);
    if (name !== '') setValues((current) => ({ ...current, recipientName: name }));
  }

  const loadData = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const [cart, zones] = await Promise.all([getCart(apiFetch), getDeliveryZones(apiFetch)]);
      setLoad({ kind: 'ready', cart, zones: zones.items });
      // A "session ended" notice from before the re-login no longer applies.
      setFailure((current) => (current?.kind === 'session' ? null : current));
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `loadData` only sets state asynchronously, after the requests start.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
  }, [status, loadData]);

  // Rate-limit cool-down: counts down once a second until the same request may be repeated.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /** Prices the cart for `district`. Resolves with the quote, or `null` when it failed. */
  const refreshQuote = useCallback(
    async (district: DistrictCode): Promise<CheckoutQuote | null> => {
      quoteSeq.current += 1;
      const sequence = quoteSeq.current;
      setQuote({ kind: 'loading', district, previous: lastQuote.current });
      try {
        const result = await quoteCheckout(apiFetch, district);
        if (sequence === quoteSeq.current) {
          lastQuote.current = result;
          setToday(todayInTashkent());
          setQuote({ kind: 'ready', district, quote: result, fetchedAt: Date.now() });
          // A choice the new quote no longer offers (another zone, a slot that filled up) is
          // dropped rather than sent.
          setSlotId((current) =>
            bookableSlot(result.delivery_slots, current) === null ? null : current,
          );
        }
        return result;
      } catch (error) {
        const classified = classifyCheckoutError(error);
        if (classified.kind === 'session') retry();
        if (sequence === quoteSeq.current) {
          setQuote({ kind: 'failed', district, failure: classified });
        }
        return null;
      }
    },
    [apiFetch, retry],
  );

  const setField = useCallback(<K extends FieldName>(field: K, value: CheckoutFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const setDistrict = useCallback(
    (district: DistrictCode | '') => {
      setField('district', district);
      setPriceChange(null);
      setSlotNotice(null);
      if (district === '') {
        quoteSeq.current += 1;
        lastQuote.current = null;
        setSlotId(null);
        setQuote({ kind: 'idle' });
      } else {
        void refreshQuote(district);
      }
    },
    [setField, refreshQuote],
  );

  const touch = useCallback((field: FieldName) => {
    setTouched((current) => (current[field] === true ? current : { ...current, [field]: true }));
  }, []);

  const clientErrors = validateForm(values);
  const formValid = Object.keys(clientErrors).length === 0;
  /**
   * Errors to show. After a submit attempt: all of them. Before: only format errors of fields the
   * customer has left, never "required". Showing "required" on blur would insert an error row
   * between the press and the release of a tap on the next control and make it miss.
   */
  const visibleErrors: FormErrors = {};
  for (const field of Object.keys(clientErrors) as FieldName[]) {
    const error = clientErrors[field];
    if (
      error !== undefined &&
      (submitAttempted || (touched[field] === true && error.kind !== 'required'))
    ) {
      visibleErrors[field] = error;
    }
  }
  for (const field of Object.keys(serverErrors) as FieldName[]) {
    const error = serverErrors[field];
    if (error !== undefined) visibleErrors[field] ??= error;
  }

  const readyQuote =
    quote.kind === 'ready' && quote.district === values.district ? quote.quote : null;

  const selectSlot = useCallback((id: string) => {
    setSlotId(id);
    setSlotNotice(null);
  }, []);
  const clearSlot = useCallback(() => {
    setSlotId(null);
    setSlotNotice(null);
  }, []);

  // The picker follows the quote for the chosen district. While that is being re-fetched it keeps
  // showing the previous quote's windows (dimmed) as long as they belong to the same zone, so
  // the list does not vanish and come back under the customer's finger.
  const districtZone = load.kind === 'ready' ? zoneForDistrict(load.zones, values.district) : null;
  const slotSource: CheckoutQuote | null =
    readyQuote ??
    (quote.kind === 'loading' &&
    quote.district === values.district &&
    quote.previous !== null &&
    districtZone !== null &&
    quote.previous.zone.id === districtZone.id
      ? quote.previous
      : null);
  const slotView =
    slotSource === null || (slotSource.delivery_slots.length === 0 && !slotSource.slot_required)
      ? null
      : {
          slots: slotSource.delivery_slots,
          required: slotSource.slot_required,
          stale: readyQuote === null,
        };
  const selectedSlot = slotView === null ? null : bookableSlot(slotView.slots, slotId);
  /** The order cannot be placed yet: this zone needs a delivery window and none is chosen. */
  const slotMissing =
    readyQuote !== null &&
    readyQuote.slot_required &&
    bookableSlot(readyQuote.delivery_slots, slotId) === null;

  const focusFirstInvalid = useCallback(
    (errors: FormErrors) => {
      const first = firstInvalidField(errors);
      if (first !== null) focusField?.(first);
    },
    [focusField],
  );

  const submit = useCallback(async () => {
    // Validation is synchronous and has no side effects, so it runs before the lock is taken:
    // tapping an incomplete form just reveals what is missing.
    setFailure(null);
    setSubmitAttempted(true);
    const errors = validateForm(values);
    if (Object.keys(errors).length > 0 || values.district === '') {
      onError?.();
      focusFirstInvalid(errors);
      return;
    }
    // The lock is a plain object, so a second tap in the same tick is refused even before React
    // has re-rendered the disabled button.
    if (!controller.tryLock()) return;
    setSubmitting(true);
    let placed = false;
    try {
      // 1. Make sure the quote is current. The total the customer has seen is the one on screen,
      //    or the one they just confirmed after a price change.
      const shown = quote.kind === 'ready' && quote.district === values.district ? quote : null;
      const seenTotal = priceChange?.to ?? shown?.quote.total_uzs ?? null;
      const fresh =
        shown !== null && Date.now() - shown.fetchedAt < QUOTE_MAX_AGE_MS
          ? shown.quote
          : await refreshQuote(values.district);
      if (fresh === null) {
        onError?.();
        return;
      }
      // The window must still be bookable in the quote we are about to order against. If the
      // customer's choice vanished (or they never made one) say so by the picker instead of
      // sending a request the server would refuse.
      const slot = bookableSlot(fresh.delivery_slots, slotId);
      if ((fresh.slot_required && slot === null) || (slotId !== null && slot === null)) {
        const reason: SlotFailureReason =
          slotId === null
            ? 'required'
            : fresh.delivery_slots.some((candidate) => candidate.id === slotId)
              ? 'full'
              : 'unavailable';
        setSlotId(null);
        setSlotNotice(reason);
        onError?.();
        focusField?.('deliverySlot');
        return;
      }
      if (seenTotal !== null && fresh.total_uzs !== seenTotal) {
        setPriceChange({ from: seenTotal, to: fresh.total_uzs });
        onError?.();
        return;
      }
      if (!fresh.can_place_order) {
        onError?.();
        return;
      }

      // 2. Place the order. Same body -> same key; any change -> a new key.
      const request = buildOrderRequest(values, fresh.total_uzs, slot?.id ?? null);
      if (request === null) return;
      const key = controller.keyFor(requestFingerprint(request));
      setPriceChange(null);
      try {
        const result = await createOrder(apiFetch, request, key);
        placed = true;
        controller.reset();
        onSuccess?.();
        onPlaced(result.order);
      } catch (error) {
        const classified = classifyCheckoutError(error);
        onError?.();
        if (classified.kind === 'slot') {
          // The server refused the window. Re-price (that refreshes the offered windows), forget
          // the choice, and use a new key for whatever is sent next.
          controller.reset();
          setSlotId(null);
          setSlotNotice(classified.reason);
          void refreshQuote(values.district);
          focusField?.('deliverySlot');
          return;
        }
        setFailure(classified);
        switch (classified.kind) {
          case 'price_changed':
            setPriceChange({ from: fresh.total_uzs, to: classified.newTotal });
            void refreshQuote(values.district);
            break;
          case 'validation':
            setServerErrors(classified.fields);
            focusFirstInvalid(classified.fields);
            break;
          case 'session':
            retry();
            break;
          case 'key_conflict':
            controller.reset();
            break;
          case 'rate_limited':
            setCooldown(classified.seconds);
            break;
          case 'insufficient_stock':
          case 'product_inactive':
          case 'cart_empty':
          case 'below_min_order':
          case 'district_not_served':
            void refreshQuote(values.district);
            break;
          default:
            break;
        }
      }
    } finally {
      // After a placed order the lock stays taken: the page is about to navigate away and a late
      // tap must not be able to start a second attempt.
      if (!placed) {
        controller.unlock();
        setSubmitting(false);
      }
    }
  }, [
    controller,
    values,
    quote,
    priceChange,
    slotId,
    refreshQuote,
    apiFetch,
    retry,
    onPlaced,
    onSuccess,
    onError,
    focusField,
    focusFirstInvalid,
  ]);

  return {
    status,
    load,
    reload: loadData,
    values,
    setField,
    setDistrict,
    touch,
    errors: visibleErrors,
    formValid,
    quote,
    readyQuote,
    slots: {
      view: slotView,
      selectedId: selectedSlot?.id ?? null,
      selected: selectedSlot,
      today,
      missing: slotMissing,
      notice: slotNotice,
      select: selectSlot,
      clear: clearSlot,
    },
    priceChange,
    failure,
    submitting,
    cooldown,
    submit,
  };
}
