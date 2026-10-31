import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  installFakeApi,
  json,
  renderAdmin,
  sessionHandler,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { IDS, category, product, subcategory } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { ProductFormView } from './product-form';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation(`/ru/catalog/products/${IDS.product}`));
afterEach(() => vi.unstubAllGlobals());

const categories: FakeHandler = (call) =>
  call.path === '/api/v1/admin/categories'
    ? json({ items: [category(), subcategory()] })
    : undefined;
const getProduct =
  (value = product()): FakeHandler =>
  (call) =>
    call.method === 'GET' && call.path === `/api/v1/admin/products/${IDS.product}`
      ? json(value)
      : undefined;

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('ProductFormView: edit', () => {
  it('maps a 422 to the right field, with an accessible error, and keeps what was typed', async () => {
    const api = installFakeApi(sessionHandler('admin'), categories, getProduct(), (call) =>
      call.method === 'PATCH'
        ? json(
            {
              error: {
                code: 'validation_error',
                message: 'x',
                details: [
                  {
                    loc: ['body', 'price_uzs'],
                    msg: 'Input should be less than or equal to 1000000000000',
                  },
                  { loc: ['body', 'image_url'], msg: 'must use https' },
                ],
              },
            },
            { status: 422 },
          )
        : undefined,
    );
    renderAdmin(<ProductFormView id={IDS.product} />);
    const price = await screen.findByTestId('price-input');
    expect(price).toHaveValue('30000');

    fireEvent.change(price, { target: { value: '31000' } });
    fireEvent.click(screen.getByTestId('save-button'));

    const message = await screen.findByText('Целое число от 0 до 1 000 000 000 000.');
    expect(price).toHaveAttribute('aria-invalid', 'true');
    expect(price.getAttribute('aria-describedby')).toContain(message.id);
    // The image field gets its own message; untouched fields stay valid.
    expect(screen.getByTestId('product-image-url')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('stock-input')).toHaveAttribute('aria-invalid', 'false');
    expect(price).toHaveValue('31000');
    // Only the changed field was sent, with the CSRF token.
    const patch = api.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ price_uzs: 31000 });
    expect(patch?.headers.get('x-csrf-token')).toBe('csrf-1');

    // Editing a rejected field clears its server error.
    fireEvent.change(price, { target: { value: '32000' } });
    expect(price).toHaveAttribute('aria-invalid', 'false');
  });

  it('checks the rules client-side first and sends nothing when they fail', async () => {
    const api = installFakeApi(sessionHandler('admin'), categories, getProduct());
    renderAdmin(<ProductFormView id={IDS.product} />);
    await screen.findByTestId('price-input');
    type('price-input', '12.5');
    type('old-price-input', '100');
    type('product-name-uz', '');
    fireEvent.click(screen.getByTestId('save-button'));

    expect(await screen.findAllByText('Обязательное поле.')).toHaveLength(1);
    expect(screen.getByTestId('price-input')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('product-name-uz')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    // Focus moves to the first problem.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('product-name-uz')));
  });

  it.each([
    ['sku_taken', 'product-sku', 'Этот артикул (SKU) уже используется. Введите другой.'],
    ['slug_taken', 'product-slug', 'Этот slug занят. Выберите другой.'],
  ])('shows %s next to the field it belongs to', async (code, testId, text) => {
    installFakeApi(sessionHandler('admin'), categories, getProduct(), (call) =>
      call.method === 'PATCH' ? apiError(409, code) : undefined,
    );
    renderAdmin(<ProductFormView id={IDS.product} />);
    await screen.findByTestId('price-input');
    type('stock-input', '1');
    fireEvent.click(screen.getByTestId('save-button'));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends null to clear an optional value (empty stock = untracked)', async () => {
    const api = installFakeApi(sessionHandler('admin'), categories, getProduct(), (call) =>
      call.method === 'PATCH' ? json(product({ stock_quantity: null })) : undefined,
    );
    renderAdmin(<ProductFormView id={IDS.product} />);
    await screen.findByTestId('price-input');
    type('stock-input', '');
    fireEvent.click(screen.getByTestId('save-button'));
    expect(await screen.findByText('Товар сохранён.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      stock_quantity: null,
    });
  });

  it('archives only after confirmation, explaining it is not a hard delete', async () => {
    const api = installFakeApi(sessionHandler('admin'), categories, getProduct(), (call) =>
      call.method === 'DELETE'
        ? json(product({ archived_at: '2026-10-31T10:00:00Z', is_active: false }))
        : undefined,
    );
    renderAdmin(<ProductFormView id={IDS.product} />);
    fireEvent.click(await screen.findByTestId('archive-product'));
    const dialog = await screen.findByRole('dialog', { name: 'Архивировать товар' });
    expect(dialog).toHaveTextContent('Это не удаление');
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('confirm-action'));
    expect(await screen.findByText(/Товар в архиве\. Чтобы редактировать/)).toBeInTheDocument();
    expect(screen.queryByTestId('save-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('restore-product')).toBeInTheDocument();
  });

  it('shows "not found" for an unknown product', async () => {
    installFakeApi(sessionHandler('admin'), categories, (call) =>
      call.path.startsWith('/api/v1/admin/products/')
        ? apiError(404, 'product_not_found')
        : undefined,
    );
    renderAdmin(<ProductFormView id={IDS.product} />);
    expect(await screen.findByText('Товар не найден')).toBeInTheDocument();
  });
});

describe('ProductFormView: create', () => {
  it('suggests the slug from the SKU until the admin edits it, and posts the full body', async () => {
    setLocation('/ru/catalog/products/new');
    const api = installFakeApi(sessionHandler('admin'), categories, (call) =>
      call.method === 'POST' && call.path === '/api/v1/admin/products'
        ? json(product(), { status: 201 })
        : undefined,
    );
    renderAdmin(<ProductFormView />);
    await screen.findByTestId('product-sku');

    type('product-sku', 'MILK_1.5L');
    expect(screen.getByTestId('product-slug')).toHaveValue('milk-1-5l');
    type('product-slug', 'my-milk');
    type('product-sku', 'MILK-2L');
    expect(screen.getByTestId('product-slug')).toHaveValue('my-milk');

    type('product-name-uz', 'Sut');
    type('product-name-ru', 'Молоко');
    type('product-category', IDS.subcategory);
    type('price-input', '12500');
    fireEvent.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      sku: 'MILK-2L',
      slug: 'my-milk',
      name_uz: 'Sut',
      name_ru: 'Молоко',
      category_id: IDS.subcategory,
      unit: 'piece',
      price_uzs: 12500,
      old_price_uzs: null,
      stock_quantity: null,
      is_active: true,
      image_url: null,
    });
  });
});
