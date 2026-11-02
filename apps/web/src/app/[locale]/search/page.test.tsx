import type { ProductPage } from '@muniramarket/contracts';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeProduct } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import SearchPage from './page';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ push: vi.fn() }),
}));

const api = vi.hoisted(() => ({ fetchProducts: vi.fn() }));
vi.mock('@/lib/api/server', () => api);

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1' },
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function results(items: ProductPage['items']): ProductPage {
  return { items, page: 1, page_size: 20, total: items.length, total_pages: 1 };
}

async function renderSearch(q: string) {
  const ui: ReactNode = await SearchPage({
    params: Promise.resolve({ locale: 'uz' }),
    searchParams: Promise.resolve({ q }),
  } as never);
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <CartProvider>{ui}</CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(makeCart()));
  api.fetchProducts.mockReset();
});

describe('search page', () => {
  it('shows an intentional no-results state with a way back', async () => {
    api.fetchProducts.mockResolvedValue(results([]));
    await renderSearch('zzzz');
    expect(screen.getByTestId('empty-panel')).toHaveTextContent('Hech narsa topilmadi');
    expect(screen.getByRole('link', { name: 'Bosh sahifaga' })).toHaveAttribute('href', '/uz');
    expect(screen.getByRole('searchbox')).toHaveValue('zzzz');
  });

  it('shows matching products as cards with cart controls', async () => {
    api.fetchProducts.mockResolvedValue(results([makeProduct()]));
    await renderSearch('olma');
    expect(screen.getAllByTestId('product-tile')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Savatga qo‘shish: Olma' })).toBeInTheDocument();
  });

  it('asks for a longer query instead of calling the API', async () => {
    await renderSearch('a');
    expect(api.fetchProducts).not.toHaveBeenCalled();
    expect(screen.getByTestId('empty-panel')).toHaveTextContent('Kamida 2 ta belgi kiriting.');
  });
});
