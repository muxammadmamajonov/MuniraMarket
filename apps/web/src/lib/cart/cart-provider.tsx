'use client';

import type { Cart, ProductSummary } from '@muniramarket/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n/context';
import { addCartItem, getCart, removeCartItem, updateCartItem } from '@/lib/api/cart';
import { ApiRequestError } from '@/lib/api/errors';
import { retryAfterSeconds } from '@/lib/checkout/failures';
import { useSession } from '@/lib/session';
import { useHaptics } from '@/lib/telegram';
import { useCooldown } from '@/lib/use-cooldown';
import { addToCartErrorMessage } from './messages';

/** What the cart needs to know about a product to change its quantity. */
export type CartProduct = Pick<ProductSummary, 'id' | 'stock_quantity'>;

export interface CartContextValue {
  /** The server's cart for the signed-in user; `null` until loaded (or when signed out). */
  cart: Cart | null;
  /** Units in the cart, as counted by the server (lines with an issue are excluded). */
  itemCount: number;
  totalUzs: number;
  /** Quantity to show for a product: the one being applied right now, else the server's. */
  quantityOf: (productId: string) => number;
  /**
   * Sets a product's quantity (0 removes it). The new value shows at once; requests for one
   * product are sent one at a time and coalesced, so rapid taps cost one round trip, not many.
   */
  setQuantity: (product: CartProduct, quantity: number) => void;
  /** Why the last change to this product failed, in the page language; `null` when it did not. */
  errorFor: (productId: string) => string | null;
  /** A 429 asked us to wait: every quantity control is locked until it is over. */
  waiting: boolean;
  /** Adopts a cart returned by another part of the app (cart page, product page). */
  replaceCart: (cart: Cart) => void;
  /** Resolves once no quantity change is queued or in flight (at once when idle). */
  settled: () => Promise<void>;
}

const CartContext = createContext<CartContextValue | null>(null);

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

interface Owned {
  userId: string;
  cart: Cart;
}

/**
 * One shared copy of the signed-in user's cart, so the header badge, the product cards and the
 * "go to cart" bar agree. It is loaded with the existing `GET /cart` once the session is
 * established and replaced by the whole `Cart` every cart call returns; nothing is ever summed
 * or multiplied on the client.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { dict } = useI18n();
  const session = useSession();
  const haptics = useHaptics();
  const { seconds: waitSeconds, start: startCooldown } = useCooldown();
  const { apiFetch, retry } = session;
  const userId = session.status === 'authenticated' ? (session.user?.id ?? 'session') : null;

  const [owned, setOwned] = useState<Owned | null>(null);
  const [pending, setPending] = useState<Readonly<Record<string, number>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  // The cart as the latest request answered it, readable from the request loop.
  const cartRef = useRef<Cart | null>(null);
  // Bumped whenever a cart is adopted, so a slow initial load cannot overwrite a newer cart.
  const generation = useRef(0);
  const desired = useRef(new Map<string, number>());
  const running = useRef(new Set<string>());
  // Callers of `settled()` waiting for the last running drain to finish.
  const idleWaiters = useRef<(() => void)[]>([]);

  const settled = useCallback(
    () =>
      running.current.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.current.push(resolve);
          }),
    [],
  );

  // A cart that belongs to another (or no) user is never shown.
  const cart = owned !== null && owned.userId === userId ? owned.cart : null;

  const adopt = useCallback(
    (next: Cart) => {
      if (userId === null) return;
      generation.current += 1;
      cartRef.current = next;
      setOwned({ userId, cart: next });
    },
    [userId],
  );

  useEffect(() => {
    if (userId === null) {
      cartRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const startedAt = generation.current;
    getCart(apiFetch)
      .then((loaded) => {
        if (cancelled || generation.current !== startedAt) return;
        generation.current += 1;
        cartRef.current = loaded;
        setOwned({ userId, cart: loaded });
      })
      .catch(() => {
        // The badge simply stays hidden; the cart page reports load failures itself, and the next
        // successful cart call brings this copy up to date.
      });
    return () => {
      cancelled = true;
    };
  }, [userId, apiFetch]);

  const drain = useCallback(
    async (productId: string) => {
      if (running.current.has(productId)) return;
      running.current.add(productId);
      try {
        for (;;) {
          const target = desired.current.get(productId);
          if (target === undefined) break;
          desired.current.delete(productId);
          const current =
            cartRef.current?.items.find((line) => line.product.id === productId)?.quantity ?? 0;
          if (target === current) continue;
          try {
            const next =
              target === 0
                ? await removeCartItem(apiFetch, productId)
                : current === 0
                  ? await addCartItem(apiFetch, { product_id: productId, quantity: target })
                  : await updateCartItem(apiFetch, productId, { quantity: target });
            adopt(next);
          } catch (error) {
            desired.current.delete(productId);
            haptics.notify('error');
            if (error instanceof ApiRequestError && error.code === 'rate_limited') {
              startCooldown(retryAfterSeconds(error.retryAfter));
              setErrors((all) => ({ ...all, [productId]: dict.product.errors.rateLimited }));
            } else {
              const message = addToCartErrorMessage(error, dict, retry);
              setErrors((all) => ({ ...all, [productId]: message }));
            }
            break;
          }
        }
      } finally {
        running.current.delete(productId);
        setPending((all) => without(all, productId));
        if (running.current.size === 0) {
          const waiters = idleWaiters.current;
          idleWaiters.current = [];
          for (const resolve of waiters) resolve();
        }
      }
    },
    [apiFetch, adopt, dict, haptics, retry, startCooldown],
  );

  const setQuantity = useCallback(
    (product: CartProduct, quantity: number) => {
      const ceiling =
        product.stock_quantity === null ? 99 : Math.max(1, Math.min(99, product.stock_quantity));
      const next = Math.max(0, Math.min(ceiling, Math.trunc(quantity)));
      setErrors((all) => (product.id in all ? without(all, product.id) : all));
      setPending((all) => ({ ...all, [product.id]: next }));
      desired.current.set(product.id, next);
      void drain(product.id);
    },
    [drain],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      itemCount: cart?.item_count ?? 0,
      totalUzs: cart?.total_uzs ?? 0,
      quantityOf: (productId) =>
        pending[productId] ??
        cart?.items.find((line) => line.product.id === productId)?.quantity ??
        0,
      setQuantity,
      errorFor: (productId) => errors[productId] ?? null,
      waiting: waitSeconds > 0,
      replaceCart: adopt,
      settled,
    }),
    [cart, pending, errors, setQuantity, waitSeconds, adopt, settled],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (value === null) throw new Error('useCart must be used inside <CartProvider>.');
  return value;
}

/** The cart, or `null` where no provider is mounted (isolated component tests). */
export function useOptionalCart(): CartContextValue | null {
  return useContext(CartContext);
}

function ignoreCart(): void {
  // Nothing to keep in sync.
}

/** Callback that hands a cart a call returned to the shared copy; a no-op without a provider. */
export function useCartSync(): (cart: Cart) => void {
  return useContext(CartContext)?.replaceCart ?? ignoreCart;
}

function alreadySettled(): Promise<void> {
  return Promise.resolve();
}

/**
 * Waits for quantity changes made elsewhere (the product cards) to reach the server, so a page
 * that loads its own copy of the cart does not read it halfway through them.
 */
export function useCartSettled(): () => Promise<void> {
  return useContext(CartContext)?.settled ?? alreadySettled;
}
