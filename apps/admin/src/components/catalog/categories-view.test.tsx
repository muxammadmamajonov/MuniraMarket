import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  installFakeApi,
  json,
  renderAdmin,
  sessionHandler,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { IDS, category, subcategory } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { CategoriesView } from './categories-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/catalog/categories'));
afterEach(() => vi.unstubAllGlobals());

const list: FakeHandler = (call) =>
  call.method === 'GET' && call.path === '/api/v1/admin/categories'
    ? json({ items: [subcategory(), category()] })
    : undefined;

describe('CategoriesView', () => {
  it('shows the tree: parents first, children indented, with counts', async () => {
    installFakeApi(sessionHandler('admin'), list);
    renderAdmin(<CategoriesView />);
    const rows = await screen.findAllByTestId('category-row');
    expect(rows[0]).toHaveTextContent('Фрукты');
    expect(rows[1]).toHaveTextContent('Яблоки');
    expect(rows[1]?.style.marginInlineStart).toBe('1.25rem');
    expect(rows[0]).toHaveTextContent('Товаров: 2');
    expect(rows[0]).toHaveTextContent('Вложенных: 1');
  });

  it('keeps a category out of its own subtree in the parent select, and maps category_cycle', async () => {
    installFakeApi(sessionHandler('admin'), list, (call) =>
      call.method === 'PATCH' ? apiError(409, 'category_cycle') : undefined,
    );
    renderAdmin(<CategoriesView />);
    fireEvent.click(
      await screen
        .findByRole('button', { name: 'Изменить', description: '' })
        .catch(() => screen.getAllByRole('button', { name: 'Изменить' })[0]!),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Редактирование категории' });
    const options = within(
      dialog.querySelector('[data-testid="category-parent"]') as HTMLElement,
    ).getAllByRole('option');
    // "Фрукты" is being edited: neither it nor its child "Яблоки" can be its parent.
    expect(options.map((option) => option.textContent)).toEqual(['Верхний уровень (без родителя)']);
    fireEvent.change(within(dialog).getByTestId('category-name-uz'), {
      target: { value: 'Mevalar 2' },
    });
    fireEvent.click(within(dialog).getByTestId('category-save'));
    await waitFor(() =>
      expect(within(dialog).getByTestId('category-parent')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(within(dialog).getByText(/нельзя вложить в саму себя/)).toBeInTheDocument();
  });

  it('refuses to delete a non-empty category with a clear message (409 category_not_empty)', async () => {
    const api = installFakeApi(sessionHandler('admin'), list, (call) =>
      call.method === 'DELETE' ? apiError(409, 'category_not_empty') : undefined,
    );
    renderAdmin(<CategoriesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить: Фрукты' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить категорию' });
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(within(dialog).getByTestId('confirm-action'));
    expect(
      await within(dialog).findByText(/В категории есть товары или вложенные категории/),
    ).toBeInTheDocument();
    expect(api.calls.find((call) => call.method === 'DELETE')?.path).toBe(
      `/api/v1/admin/categories/${IDS.category}`,
    );
  });

  it('creates a category and toggles active', async () => {
    const api = installFakeApi(sessionHandler('admin'), list, (call) =>
      call.method === 'POST'
        ? json(category({ id: 'n' }), { status: 201 })
        : call.method === 'PATCH'
          ? json(category())
          : undefined,
    );
    renderAdmin(<CategoriesView />);
    fireEvent.click(await screen.findByTestId('new-category'));
    const dialog = await screen.findByRole('dialog', { name: 'Новая категория' });
    fireEvent.change(within(dialog).getByTestId('category-name-uz'), {
      target: { value: 'Sabzavotlar' },
    });
    fireEvent.change(within(dialog).getByTestId('category-name-ru'), {
      target: { value: 'Овощи' },
    });
    fireEvent.change(within(dialog).getByTestId('category-slug'), { target: { value: 'veg' } });
    fireEvent.click(within(dialog).getByTestId('category-save'));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      slug: 'veg',
      name_uz: 'Sabzavotlar',
      name_ru: 'Овощи',
      parent_id: null,
      is_active: true,
      image_url: null,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Фрукты: активность' }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ is_active: false });
  });
});
