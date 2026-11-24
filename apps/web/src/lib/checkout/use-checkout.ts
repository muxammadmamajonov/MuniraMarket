'use client';

import type { Cart, CheckoutQuote, OrderDetail, OrderSummary } from '@muniramarket/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from '@/lib/address/address';
import { readDeliveryAddress, writeDeliveryAddress } from '@/lib/address/storage';
import { getCart } from '@/lib/api/cart';
import { ApiRequestError } from '@/lib/api/errors';
import { createOrder, listOrders, quoteCheckout } from '@/lib/api/orders';
import { useSession } from '@/lib/session';
import { useCooldown } from '@/lib/use-cooldown';
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
import { clearPendingAttempt, findOrderForAttempt, readPendingAttempt } from './pending-attempt';

/** A quote older than this is re-fetched before the order is placed (prices and stock move). */
export const QUOTE_MAX_AGE_MS = 60_000;

/** How many of the newest orders are searched for the one a pending attempt created. */
const RECOVERY_PAGE_SIZE = 5;

export type CheckoutLoad =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      cart: Cart;
      /**
       * The order an earlier, unconfirmed attempt in this tab created (found after a reload: the
       * cart came back empty because the order took its items).
       */
      recovered: OrderSummary | null;
    }
  | { kind: 'failed' };

export type QuoteState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; quote: CheckoutQuote; fetchedAt: number }
  | { kind: 'failed'; failure: CheckoutFailure };

/** The customer confirmed `from`; the server would now charge `to`. Needs an explicit confirm. */
export interface PriceChange {
  from: number;
  to: number;
}

/**
 * A form field, or the summary's "could not price the cart" message: not a form field of its own,
 * but a refused submit moves the customer to it.
 */
export type FocusTarget = FieldName | 'quote';

export interface CheckoutFlowOptions {
  /**
   * Called after the order exists, with the order. `replayed`: the API recognised the key and
   * returned an order that an earlier attempt had already created.
   */
  onPlaced: (order: OrderDetail, replayed: boolean) => void;
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
 * State machine behind the checkout page: loads and prices the cart, holds the delivery address
 * (prefilled from the one saved on this device), and places the order with idempotency and
 * double-submit protection. Delivery itself is not priced: a Yandex Go courier brings the order
 * and the customer pays the courier.
 */
export function useCheckoutFlow({ onPlaced, onSuccess, onError, focusField }: CheckoutFlowOptions) {
  const { status, user, apiFetch, retry } = useSession();
  const controller = useSubmissionController();

  const [load, setLoad] = useState<CheckoutLoad>({ kind: 'loading' });
  // The address saved on this device (home card or an earlier checkout) is the starting point.
  const [values, setValues] = useState<CheckoutFormValues>(() => ({
    ...emptyFormValues(),
    address: readDeliveryAddress(),
  }));
  const [prefilled, setPrefilled] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<FieldName, true>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FormErrors>({});
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' });
  const [priceChange, setPriceChange] = useState<PriceChange | null>(null);
  const [failure, setFailure] = useState<CheckoutFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { seconds: cooldown, start: startCooldown } = useCooldown();
  const quoteSeq = useRef(0);

  // Prefill the recipient's name once, from the signed-in user (adjusting state while rendering is
  // the supported way to derive state from a value that arrives later).
  if (!prefilled && user !== null) {
    setPrefilled(true);
    const name = displayName(user);
    if (name !== '') setValues((current) => ({ ...current, recipientName: name }));
  }

  const owner = user?.id ?? '';

  /**
   * After a reload, an empty cart plus a pending attempt means the attempt most likely went
   * through (placing an order empties the cart). Look for that order among the newest ones.
   */
  const recoverOrder = useCallback(async (): Promise<OrderSummary | null> => {
    const pending = readPendingAttempt();
    if (pending === null || pending.owner !== owner) return null;
    try {
      const page = await listOrders(apiFetch, { pageSize: RECOVERY_PAGE_SIZE });
      // With an empty cart the attempt can no longer be retried either way.
      clearPendingAttempt();
      return findOrderForAttempt(pending, page.items);
    } catch {
      return null; // kept: the next load asks again
    }
  }, [apiFetch, owner]);

  const loadData = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const cart = await getCart(apiFetch);
      const recovered = cart.items.length === 0 ? await recoverOrder() : null;
      setLoad({ kind: 'ready', cart, recovered });
      // A "session ended" notice from before the re-login no longer applies.
      setFailure((current) => (current?.kind === 'session' ? null : current));
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry, recoverOrder]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // `loadData` only sets state asynchronously, after the requests start.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
  }, [status, loadData]);

  /** Prices the cart. Resolves with the quote, or `null` when it failed. */
  const refreshQuote = useCallback(async (): Promise<CheckoutQuote | null> => {
    quoteSeq.current += 1;
    const sequence = quoteSeq.current;
    setQuote({ kind: 'loading' });
    try {
      const result = await quoteCheckout(apiFetch);
      if (sequence === quoteSeq.current) {
        setQuote({ kind: 'ready', quote: result, fetchedAt: Date.now() });
      }
      return result;
    } catch (error) {
      const classified = classifyCheckoutError(error);
      if (classified.kind === 'session') retry();
      // A refused quote is waited out like a refused order: whatever would ask again (the retry
      // button, the submit control) stays disabled until `Retry-After` has passed.
      if (classified.kind === 'rate_limited') startCooldown(classified.seconds);
      if (sequence === quoteSeq.current) setQuote({ kind: 'failed', failure: classified });
      return null;
    }
  }, [apiFetch, retry, startCooldown]);

  // Price the cart once it has loaded (and again after a reload of the page data).
  useEffect(() => {
    if (load.kind !== 'ready' || load.cart.items.length === 0) return;
    // The request is async; its state changes happen when it settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshQuote();
  }, [load, refreshQuote]);

  /** Asks again for the quote that failed (the summary's retry button). */
  const retryQuote = useCallback(() => {
    if (cooldown > 0) return;
    void refreshQuote();
  }, [cooldown, refreshQuote]);

  const setField = useCallback(<K extends FieldName>(field: K, value: CheckoutFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  /** The address from the map picker; also remembered on this device for the next order. */
  const setAddress = useCallback(
    (address: Address) => {
      setField('address', address);
      writeDeliveryAddress(address);
    },
    [setField],
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

  const readyQuote = quote.kind === 'ready' ? quote.quote : null;

  const focusFirstInvalid = useCallback(
    (errors: FormErrors) => {
      const first = firstInvalidField(errors);
      if (first !== null) focusField?.(first);
    },
    [focusField],
  );

  const submit = useCallback(async () => {
    // A rate limit is waited out. The controls are disabled meanwhile; this is the same rule for
    // anything that reaches the handler anyway (an implicit form submission, a stale MainButton).
    if (cooldown > 0) return;
    // Validation is synchronous and has no side effects, so it runs before the lock is taken:
    // tapping an incomplete form just reveals what is missing.
    setFailure(null);
    setSubmitAttempted(true);
    const errors = validateForm(values);
    if (Object.keys(errors).length > 0) {
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
      const shown = quote.kind === 'ready' ? quote : null;
      const seenTotal = priceChange?.to ?? shown?.quote.total_uzs ?? null;
      const fresh =
        shown !== null && Date.now() - shown.fetchedAt < QUOTE_MAX_AGE_MS
          ? shown.quote
          : await refreshQuote();
      if (fresh === null) {
        // The summary says why (and offers a retry); take the customer there.
        onError?.();
        focusField?.('quote');
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
      const key = controller.keyFor(requestFingerprint(request), {
        owner,
        totalUzs: request.expected_total_uzs,
      });
      setPriceChange(null);
      try {
        const result = await createOrder(apiFetch, request, key);
        placed = true;
        controller.reset();
        onSuccess?.();
        onPlaced(result.order, result.replayed);
      } catch (error) {
        const classified = classifyCheckoutError(error);
        onError?.();
        setFailure(classified);
        switch (classified.kind) {
          case 'price_changed':
            setPriceChange({ from: fresh.total_uzs, to: classified.newTotal });
            void refreshQuote();
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
            startCooldown(classified.seconds);
            break;
          case 'insufficient_stock':
          case 'product_inactive':
          case 'cart_empty':
            void refreshQuote();
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
    cooldown,
    startCooldown,
    values,
    quote,
    priceChange,
    refreshQuote,
    apiFetch,
    retry,
    owner,
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
    setAddress,
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
    retryQuote,
  };
}
