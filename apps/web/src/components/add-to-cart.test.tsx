import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
