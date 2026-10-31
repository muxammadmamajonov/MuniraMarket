import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { AddToCart } from './add-to-cart';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSession: () => session }));

const product: Parameters<typeof AddToCart>[0]['product'] = {
  id: 'p1',
  price_uzs: 12500,
  in_stock: true,
  stock_quantity: null,
};

function renderAdd(overrides: Partial<typeof product> = {}) {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <AddToCart product={{ ...product, ...overrides }} />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

/** Advances the fake clock a second at a time until `done()` (bounded: never loops forever). */
async function tickUntil(done: () => boolean, max = 15) {
  for (let second = 0; second < max && !done(); second += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

const emptyCart = { items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0, has_issues: false };

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(emptyCart));
});

afterEach(() => {
  uninstallWebApp();
});

describe('AddToCart', () => {
  it('posts the product id and the stepper quantity, then confirms', async () => {
    renderAdd();
    fireEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qo‘shish' }));

    expect(await screen.findByTestId('added-message')).toHaveTextContent('Savatga qo‘shildi');
    const [path, init] = session.apiFetch.mock.calls[0] ?? [];
    expect(path).toBe('/cart/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: 'p1', quantity: 2 });
    expect(screen.getByRole('link', { name: 'Savatni ochish' })).toHaveAttribute(
      'href',
      '/uz/cart',
    );
  });

  it('is not rendered for an out-of-stock product', () => {
    const { container } = renderAdd({ in_stock: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('limits the stepper to the tracked stock', () => {
    renderAdd({ stock_quantity: 2 });
    const more = screen.getByRole('button', { name: 'Ko‘paytirish' });
    fireEvent.click(more);
    expect(more).toBeDisabled();
    expect(screen.getByText('Bir buyurtmada ko‘pi bilan 2 ta.')).toBeInTheDocument();
  });

  it('shows the available quantity when the server reports insufficient stock', async () => {
    session.apiFetch.mockResolvedValue(
      Response.json(
        { error: { code: 'insufficient_stock', message: 'x', available_quantity: 1 } },
        { status: 409 },
      ),
    );
    renderAdd();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qo‘shish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Omborda yetarli emas. Mavjud: 1.');
  });

  it('shows a generic error when the request fails', async () => {
    session.apiFetch.mockRejectedValue(new TypeError('offline'));
    renderAdd();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qo‘shish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Savatga qo‘shib bo‘lmadi');
  });

  describe('when the API says to slow down (429)', () => {
    const limited = (retryAfter?: string) =>
      Response.json(
        { error: { code: 'rate_limited', message: 'x' } },
        {
          status: 429,
          ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
        },
      );

    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('says so, disables the button for Retry-After, then lets the customer try again', async () => {
      session.apiFetch.mockResolvedValueOnce(limited('2'));
      renderAdd();
      const add = screen.getByRole('button', { name: 'Savatga qo‘shish' });
      fireEvent.click(add);

      expect(await screen.findByTestId('rate-limited')).toHaveTextContent(
        'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.',
      );
      expect(add).toBeDisabled();
      fireEvent.click(add);
      expect(session.apiFetch).toHaveBeenCalledTimes(1); // nothing is sent while waiting

      await tickUntil(() => !(add as HTMLButtonElement).disabled);
      expect(add).toBeEnabled();
      expect(screen.queryByTestId('rate-limited')).toBeNull();

      fireEvent.click(add);
      expect(await screen.findByTestId('added-message')).toBeInTheDocument();
      expect(session.apiFetch).toHaveBeenCalledTimes(2);
    });

    it('waits 10 s when the API did not say how long, and speaks Russian', async () => {
      session.apiFetch.mockResolvedValueOnce(limited());
      render(
        <LocaleProvider locale="ru">
          <TelegramProvider>
            <AddToCart product={product} />
          </TelegramProvider>
        </LocaleProvider>,
      );
      const add = screen.getByRole('button', { name: 'В корзину' });
      fireEvent.click(add);
      expect(await screen.findByTestId('rate-limited')).toHaveTextContent(
        'Слишком много попыток. Повторите чуть позже.',
      );
      // Half way through the default 10 s it is still locked (a margin that real time passing in
      // the test cannot eat), and after 10 more it is free.
      for (let second = 0; second < 5; second += 1) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
      }
      expect(add).toBeDisabled();
      await tickUntil(() => !(add as HTMLButtonElement).disabled);
      expect(add).toBeEnabled();
    });

    it('keeps the Telegram MainButton disabled while waiting', async () => {
      const webApp = makeWebApp();
      installWebApp(webApp);
      session.apiFetch.mockResolvedValueOnce(limited('3'));
      renderAdd();
      await waitFor(() => expect(webApp.MainButton.show).toHaveBeenCalled());
      const handler = vi.mocked(webApp.MainButton.onClick).mock.calls.at(-1)?.[0];
      act(() => handler?.());
      await screen.findByTestId('rate-limited');
      await waitFor(() => expect(webApp.MainButton.disable).toHaveBeenCalled());
      const latest = vi.mocked(webApp.MainButton.onClick).mock.calls.at(-1)?.[0];
      act(() => latest?.());
      expect(session.apiFetch).toHaveBeenCalledTimes(1);
    });
  });

  it('disables the button and shows the sign-in prompt when anonymous', () => {
    session.status = 'anonymous';
    renderAdd();
    expect(screen.getByRole('button', { name: 'Savatga qo‘shish' })).toBeDisabled();
    expect(screen.getByText(/Telegram orqali oching/)).toBeInTheDocument();
  });

  describe('inside Telegram', () => {
    it('offers the MainButton "Add to cart — price" and adds the stepper quantity on click', async () => {
      const webApp = makeWebApp({
        HapticFeedback: {
          impactOccurred: vi.fn(),
          notificationOccurred: vi.fn(),
          selectionChanged: vi.fn(),
        },
      });
      installWebApp(webApp);
      renderAdd();

      await waitFor(() =>
        expect(webApp.MainButton.setText).toHaveBeenCalledWith('Savatga qo‘shish — 12 500 so‘m'),
      );
      expect(webApp.MainButton.show).toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));
      const handler = vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0];
      handler?.();

      await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
      expect(JSON.parse(String(session.apiFetch.mock.calls[0]?.[1]?.body))).toEqual({
        product_id: 'p1',
        quantity: 2,
      });
      await waitFor(() =>
        expect(webApp.HapticFeedback?.notificationOccurred).toHaveBeenCalledWith('success'),
      );
    });

    it('hides the MainButton and removes its listener on unmount', () => {
      const webApp = makeWebApp();
      installWebApp(webApp);
      const { unmount } = renderAdd();
      const handler = vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0];
      unmount();
      expect(webApp.MainButton.offClick).toHaveBeenCalledWith(handler);
      expect(webApp.MainButton.hide).toHaveBeenCalled();
    });

    it('does not claim the MainButton for an out-of-stock product', () => {
      const webApp = makeWebApp();
      installWebApp(webApp);
      renderAdd({ in_stock: false });
      expect(webApp.MainButton.show).not.toHaveBeenCalled();
    });
  });
});
