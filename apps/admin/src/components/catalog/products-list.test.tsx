import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, money, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { IDS, category, page, product, subcategory } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { ProductsList } from './products-list';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/catalog/products'));
afterEach(() => vi.unstubAllGlobals());

const handlers = (items = [product()], extra: Record<string, unknown> = {}) => [
  sessionHandler('admin'),
  (call: { path: string }) =>
    call.path === '/api/v1/admin/categories'
      ? json({ items: [category(), subcategory()] })
      : undefined,
  (call: { path: string }) =>
    call.path.startsWith('/api/v1/admin/products?') ? json(page(items, extra)) : undefined,
];

describe('ProductsList', () => {
  it('renders rows with a link, price, untracked stock and status, and requests page 1', async () => {
    const api = installFakeApi(
      ...handlers([
        product(),
        product({ id: 'b', sku: 'B', stock_quantity: null, is_active: false }),
      ]),
    );
    renderAdmin(<ProductsList />);
    const links = await screen.findAllByTestId('product-row-link');
    expect(links[0]).toHaveTextContent('Тестовое яблоко');
    expect(links[0]).toHaveAttribute('href', `/ru/catalog/products/${IDS.product}`);
    expect(screen.getAllByText(money(30000, 'ru'))[0]).toBeInTheDocument();
    expect(screen.getByText('Без учёта')).toBeInTheDocument();
    expect(screen.getByText('Неактивен')).toBeInTheDocument();
    expect(api.to('/api/v1/admin/products')[0]?.path).toBe(
      '/api/v1/admin/products?page=1&page_size=20',
    );
  });

  it('searches through the URL: the query goes to the API and survives in the box', async () => {
    const api = installFakeApi(...handlers());
    renderAdmin(<ProductsList />);
    await screen.findByTestId('product-row-link');
    const box = screen.getByTestId('product-search');
    expect(box).toHaveAccessibleName('Поиск товаров');
    fireEvent.change(box, { target: { value: 'ябл' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() =>
      expect(api.to('/api/v1/admin/products').at(-1)?.path).toContain(
        `q=${encodeURIComponent('ябл')}`,
      ),
    );
    expect(screen.getByTestId('product-search')).toHaveValue('ябл');
  });

  it('applies status and category filters from the URL, and ignores junk', async () => {
    setLocation(`/ru/catalog/products?status=archived&category_id=${IDS.subcategory}&page=2`);
    const api = installFakeApi(...handlers([], { page: 2, total_pages: 2, total: 21 }));
    renderAdmin(<ProductsList />);
    await screen.findByText('По фильтрам ничего не найдено.');
    expect(api.to('/api/v1/admin/products')[0]?.path).toBe(
      `/api/v1/admin/products?page=2&page_size=20&status=archived&category_id=${IDS.subcategory}`,
    );
    act(() => setLocation('/ru/catalog/products?status=bogus&category_id=nope&page=-3'));
    await waitFor(() =>
      expect(api.to('/api/v1/admin/products').at(-1)?.path).toBe(
        '/api/v1/admin/products?page=1&page_size=20',
      ),
    );
  });

  it('shows the pager only when there is more than one page', async () => {
    installFakeApi(...handlers([product()], { total_pages: 3, total: 55 }));
    renderAdmin(<ProductsList />);
    const pager = await screen.findByRole('navigation', { name: 'Страницы' });
    expect(within(pager).getByRole('link', { name: 'Далее' })).toHaveAttribute(
      'href',
      '/ru/catalog/products?page=2',
    );
  });
});
