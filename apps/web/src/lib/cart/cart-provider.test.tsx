import type { Cart } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { CartProvider, useCart, useCartSync, type CartProduct } from './cart-provider';
import { makeCart, makeLine, makeProduct } from './test-fixtures';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1' } as { id: string } | null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSession: () => session }));

const apple = makeProduct();
const product: CartProduct = { id: apple.id, stock_quantity: null };

function Probe({ target = product }: { target?: CartProduct }) {
  const cart = useCart();
  return (
    <div>
      <output data-testid="count">{cart.itemCount}</output>
      <output data-testid="total">{cart.totalUzs}</output>
      <output data-testid="qty">{cart.quantityOf(target.id)}</output>
      <output data-testid="error">{cart.errorFor(target.id) ?? ''}</output>
      <output data-testid="waiting">{String(cart.waiting)}</output>
      <button onClick={() => cart.setQuantity(target, cart.quantityOf(target.id) + 1)}>inc</button>
      <button onClick={() => cart.setQuantity(target, 0)}>zero</button>
      <button onClick={() => cart.setQuantity(target, 3)}>three</button>
    </div>
  );
}

function renderProvider(children: ReactNode = <Probe />) {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <CartProvider>{children}</CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

function route(
  handler: (path: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  session.apiFetch.mockImplementation(async (path, init) => handler(path, init));
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  session.status = 'authenticated';
  session.user = { id: 'u1' };
  session.apiFetch.mockReset();
  session.retry.mockReset();
});

describe('CartProvider', () => {
  it('loads the cart once the session is authenticated and exposes the server counts', async () => {
    route(() => Response.json(makeCart([makeLine(apple, 2)])));
    renderProvider();
    await waitFor(() => expect(text('count')).toBe('2'));
    expect(text('total')).toBe('25000');
    expect(text('qty')).toBe('2');
    expect(session.apiFetch).toHaveBeenCalledWith('/cart', { method: 'GET' });
  });

  it('does not load a cart without a session', () => {
    session.status = 'anonymous';
    session.user = null;
    renderProvider();
    expect(session.apiFetch).not.toHaveBeenCalled();
    expect(text('count')).toBe('0');
  });

  it('adds a product that is not in the cart with POST /cart/items and shows the quantity at once', async () => {
    let release: (cart: Cart) => void = () => undefined;
    route((path, init) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          release = (cart) => resolve(Response.json(cart));
        });
      }
      return Response.json(makeCart());
    });
    renderProvider();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByText('inc'));
    // Optimistic: the stepper value is there before the server answered.
    expect(text('qty')).toBe('1');
    expect(text('count')).toBe('0');

    await act(async () => release(makeCart([makeLine(apple, 1)])));
    await waitFor(() => expect(text('count')).toBe('1'));
    const post = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/cart/items');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ product_id: 'p1', quantity: 1 });
  });

  it('settles only after every queued change has reached the server', async () => {
    let release: (cart: Cart) => void = () => undefined;
    route((path, init) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          release = (cart) => resolve(Response.json(cart));
        });
      }
      return Response.json(makeCart());
    });
    const onSettled = vi.fn();
    function WaitButton() {
      const { settled } = useCart();
      return <button onClick={() => void settled().then(onSettled)}>wait</button>;
    }
    renderProvider(
      <>
        <Probe />
        <WaitButton />
      </>,
    );
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByText('inc'));
    fireEvent.click(screen.getByText('wait'));
    await act(async () => Promise.resolve());
    expect(onSettled).not.toHaveBeenCalled();

    await act(async () => release(makeCart([makeLine(apple, 1)])));
    await waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  });

  it('changes a line already in the cart with PUT and removes it with DELETE at zero', async () => {
    route((path, init) => {
      if (init?.method === 'PUT') return Response.json(makeCart([makeLine(apple, 4)]));
      if (init?.method === 'DELETE') return Response.json(makeCart());
      return Response.json(makeCart([makeLine(apple, 3)]));
    });
    renderProvider();
    await waitFor(() => expect(text('qty')).toBe('3'));

    fireEvent.click(screen.getByText('inc'));
    await waitFor(() => expect(text('count')).toBe('4'));
    const put = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/cart/items/p1');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ quantity: 4 });

    fireEvent.click(screen.getByText('zero'));
    await waitFor(() => expect(text('count')).toBe('0'));
    const del = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(del?.[0]).toBe('/cart/items/p1');
  });

  it('coalesces rapid taps on one product into the last wanted quantity', async () => {
    const writes: string[] = [];
    let release: (cart: Cart) => void = () => undefined;
    route((path, init) => {
      if (init?.method === 'POST') {
        writes.push(`POST ${String(init.body)}`);
        return new Promise<Response>((resolve) => {
          release = (cart) => resolve(Response.json(cart));
        });
      }
      if (init?.method === 'PUT') {
        writes.push(`PUT ${String(init.body)}`);
        return Response.json(makeCart([makeLine(apple, 3)]));
      }
      return Response.json(makeCart());
    });
    renderProvider();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());

    fireEvent.click(screen.getByText('inc')); // 1: request goes out
    fireEvent.click(screen.getByText('inc')); // 2: waits
    fireEvent.click(screen.getByText('inc')); // 3: replaces the wait
    expect(text('qty')).toBe('3');

    await act(async () => release(makeCart([makeLine(apple, 1)])));
    await waitFor(() => expect(text('count')).toBe('3'));
    expect(writes).toEqual(['POST {"product_id":"p1","quantity":1}', 'PUT {"quantity":3}']);
  });

  it('caps the wanted quantity at the tracked stock', async () => {
    route((path, init) =>
      init?.method === 'POST'
        ? Response.json(makeCart([makeLine(apple, 2)]))
        : Response.json(makeCart()),
    );
    renderProvider(<Probe target={{ id: 'p1', stock_quantity: 2 }} />);
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText('three'));
    expect(text('qty')).toBe('2');
  });

  it('shows the available quantity for insufficient stock and drops the optimistic value', async () => {
    route((path, init) =>
      init?.method === 'POST'
        ? Response.json(
            { error: { code: 'insufficient_stock', message: 'x', available_quantity: 1 } },
            { status: 409 },
          )
        : Response.json(makeCart()),
    );
    renderProvider();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText('inc'));
    await waitFor(() => expect(text('error')).toBe('Omborda yetarli emas. Mavjud: 1.'));
    expect(text('qty')).toBe('0');
  });

  it('locks the controls for Retry-After after a 429', async () => {
    route((path, init) =>
      init?.method === 'POST'
        ? Response.json(
            { error: { code: 'rate_limited', message: 'x' } },
            { status: 429, headers: { 'Retry-After': '30' } },
          )
        : Response.json(makeCart()),
    );
    renderProvider();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText('inc'));
    await waitFor(() => expect(text('waiting')).toBe('true'));
    expect(text('error')).toBe('Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.');
  });

  it('does not let a slow initial load overwrite a newer cart', async () => {
    let finishLoad: (cart: Cart) => void = () => undefined;
    route((path, init) => {
      if (init?.method === 'POST') return Response.json(makeCart([makeLine(apple, 1)]));
      return new Promise<Response>((resolve) => {
        finishLoad = (cart) => resolve(Response.json(cart));
      });
    });
    renderProvider();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText('inc'));
    await waitFor(() => expect(text('count')).toBe('1'));
    await act(async () => finishLoad(makeCart()));
    expect(text('count')).toBe('1');
  });

  it('adopts a cart handed over through useCartSync', async () => {
    route(() => Response.json(makeCart()));
    function Pusher() {
      const sync = useCartSync();
      return <button onClick={() => sync(makeCart([makeLine(apple, 5)]))}>push</button>;
    }
    renderProvider(
      <>
        <Probe />
        <Pusher />
      </>,
    );
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByText('push'));
    await waitFor(() => expect(text('count')).toBe('5'));
  });

  it('useCartSync is a harmless no-op without a provider', () => {
    function Pusher() {
      const sync = useCartSync();
      return <button onClick={() => sync(makeCart())}>push</button>;
    }
    render(<Pusher />);
    expect(() => fireEvent.click(screen.getByText('push'))).not.toThrow();
  });
});
