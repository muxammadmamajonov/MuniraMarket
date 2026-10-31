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
import { classifyCheckoutError, type CheckoutFailure } from './failures';
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

/** A quote older than this is re-fetched before the order is placed (prices and stock move). */
export const QUOTE_MAX_AGE_MS = 60_000;

export type CheckoutLoad =
  { kind: 'loading' } | { kind: 'ready'; cart: Cart; zones: DeliveryZone[] } | { kind: 'failed' };

export type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading'; district: DistrictCode }
  | { kind: 'ready'; district: DistrictCode; quote: CheckoutQuote; fetchedAt: number }
  | { kind: 'failed'; district: DistrictCode; failure: CheckoutFailure };

/** The customer confirmed `from`; the server would now charge `to`. Needs an explicit confirm. */
export interface PriceChange {
  from: number;
  to: number;
}

export interface CheckoutFlowOptions {
  /** Called after the order exists, with the created order. */
  onPlaced: (order: OrderDetail) => void;
  /** Haptic hooks, injected so the flow itself stays free of Telegram specifics. */
  onSuccess?: () => void;
  onError?: () => void;
  /** Moves focus to a form field (the view owns the DOM). */
  focusField?: (field: FieldName) => void;
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
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const quoteSeq = useRef(0);

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
      setQuote({ kind: 'loading', district });
      try {
        const result = await quoteCheckout(apiFetch, district);
        if (sequence === quoteSeq.current) {
          setQuote({ kind: 'ready', district, quote: result, fetchedAt: Date.now() });
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
      if (district === '') {
        quoteSeq.current += 1;
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
      const request = buildOrderRequest(values, fresh.total_uzs);
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
    refreshQuote,
    apiFetch,
    retry,
    onPlaced,
    onSuccess,
    onError,
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
    priceChange,
    failure,
    submitting,
    cooldown,
    submit,
  };
}
