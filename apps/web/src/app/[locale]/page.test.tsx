import type { CategoryNode, ProductPage } from '@muniramarket/contracts';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeProduct } from '@/lib/cart/test-fixtures';
import { ADDRESS_STORAGE_ITEM, resetDeliveryAddressMemory } from '@/lib/address/storage';
import { TelegramProvider } from '@/lib/telegram';
import HomePage from './page';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ push: vi.fn() }),
}));

const api = vi.hoisted(() => ({
  fetchCategories: vi.fn(),
  fetchProducts: vi.fn(),
}));
vi.mock('@/lib/api/server', () => api);

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1' },
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function category(id: string, slug: string, name: string): CategoryNode {
  return { id, slug, name_uz: name, name_ru: name, image_url: null, sort_order: 0, children: [] };
}

function page(items: ProductPage['items']): ProductPage {
  return { items, page: 1, page_size: 24, total: items.length, total_pages: 1 };
}

async function renderHome(locale: 'uz' | 'ru' = 'uz') {
  const ui: ReactNode = await HomePage({ params: Promise.resolve({ locale }) } as never);
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartProvider>{ui}</CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(makeCart()));
  api.fetchCategories.mockReset();
  api.fetchProducts.mockReset();
  window.localStorage.clear();
  resetDeliveryAddressMemory();
});

describe('home page', () => {
  it('has the delivery address card, search, category shortcuts, the payment note and a grid', async () => {
    api.fetchCategories.mockResolvedValue([
      category('c1', 'meva', 'Meva'),
      category('c2', 'sabzavot', 'Sabzavot'),
    ]);
    api.fetchProducts.mockResolvedValue(
      page([makeProduct(), makeProduct({ id: 'p2', slug: 'demo-uzum', name_uz: 'Uzum' })]),
    );
    await renderHome();

    expect(screen.getByRole('heading', { level: 1, name: 'MuniraMarket' })).toBeInTheDocument();
    const search = screen.getByRole('search', { name: 'Mahsulot qidirish' });
    const input = within(search).getByRole('searchbox');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('enterkeyhint', 'search');

    const rail = screen.getByRole('navigation', { name: 'Kategoriyalar' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/uz/c/meva', '/uz/c/sabzavot']);

    // The address card comes first and does not block the catalog below it.
    const address = screen.getByTestId('delivery-address');
    expect(address).toHaveAttribute('data-state', 'unset');
    expect(address).toHaveTextContent('Yetkazish manzilini tanlang');
    expect(address.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByTestId('delivery-info')).toHaveTextContent('To‘lov yetkazilganda');

    const grid = screen.getByRole('list', { name: 'Yangi mahsulotlar' });
    expect(within(grid).getAllByTestId('product-tile')).toHaveLength(2);
    expect(grid).toHaveClass('grid-cols-2');
    expect(api.fetchProducts).toHaveBeenCalledWith({ sort: 'newest', page: 1, pageSize: 24 });
  });

  it('shows an intentional empty state when there are no categories and no products', async () => {
    api.fetchCategories.mockResolvedValue([]);
    api.fetchProducts.mockResolvedValue(page([]));
    await renderHome();
    expect(screen.getByTestId('empty-panel')).toHaveTextContent('Katalog hozircha bo‘sh');
    expect(screen.getByTestId('empty-panel')).toHaveTextContent(
      'Mahsulotlar tez orada qo‘shiladi.',
    );
    expect(screen.queryByRole('list', { name: 'Yangi mahsulotlar' })).not.toBeInTheDocument();
    // The search stays usable.
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('omits an empty section instead of rendering a bare heading', async () => {
    api.fetchCategories.mockResolvedValue([]);
    api.fetchProducts.mockResolvedValue(page([makeProduct()]));
    await renderHome();
    expect(screen.queryByRole('heading', { name: 'Kategoriyalar' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Yangi mahsulotlar' })).toBeInTheDocument();
  });

  it('is localized', async () => {
    api.fetchCategories.mockResolvedValue([]);
    api.fetchProducts.mockResolvedValue(page([]));
    await renderHome('ru');
    expect(screen.getByTestId('empty-panel')).toHaveTextContent('Каталог пока пуст');
    expect(screen.getByTestId('delivery-address')).toHaveTextContent('Выберите адрес доставки');
  });

  it('shows the saved delivery address above the catalog', async () => {
    window.localStorage.setItem(
      ADDRESS_STORAGE_ITEM,
      JSON.stringify({
        lat: 41.311081,
        lon: 69.240562,
        street: 'Amir Temur ko‘chasi',
        house: '15',
        apartment: '4',
      }),
    );
    api.fetchCategories.mockResolvedValue([]);
    api.fetchProducts.mockResolvedValue(page([makeProduct()]));
    await renderHome();
    expect(screen.getByTestId('delivery-address')).toHaveAttribute('data-state', 'set');
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(
      'Amir Temur ko‘chasi, 15, 4-xonadon',
    );
    expect(screen.getByRole('list', { name: 'Yangi mahsulotlar' })).toBeInTheDocument();
  });
});
