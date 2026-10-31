import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  installFakeApi,
  json,
  renderAdmin,
  sessionHandler,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { IDS, adminUser, page } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { UsersView, userDisplayName } from './users-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/users'));
afterEach(() => vi.unstubAllGlobals());

const list =
  (...users: ReturnType<typeof adminUser>[]): FakeHandler =>
  (call) =>
    call.method === 'GET' && call.path.startsWith('/api/v1/admin/users')
      ? json(page(users))
      : undefined;

describe('UsersView', () => {
  it('lists users without ever showing a phone and sends the role filter and search', async () => {
    const api = installFakeApi(
      sessionHandler('admin'),
      list(
        adminUser(),
        adminUser({ id: 'x', username: null, last_name: null, telegram_user_id: 9 }),
      ),
    );
    renderAdmin(<UsersView />);
    expect(await screen.findAllByTestId('user-row')).toHaveLength(2);
    expect(screen.getByText(/@test_admin/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/phone|телефон|\+998/i);
    expect(api.to('/api/v1/admin/users')[0]?.path).toBe('/api/v1/admin/users?page=1&page_size=20');

    // Filter chips are plain links (the URL is the state); following one reloads with the filter.
    expect(screen.getByRole('link', { name: 'Оператор' })).toHaveAttribute(
      'href',
      '/ru/users?role=operator',
    );
    act(() => setLocation('/ru/users?role=operator'));
    await waitFor(() =>
      expect(api.to('/api/v1/admin/users').at(-1)?.path).toContain('role=operator'),
    );
    fireEvent.change(screen.getByTestId('user-search'), { target: { value: 'ali' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(api.to('/api/v1/admin/users').at(-1)?.path).toContain('q=ali'));
  });

  it('asks for confirmation before a role change and shows the last_admin refusal', async () => {
    const api = installFakeApi(sessionHandler('admin'), list(adminUser()), (call) =>
      call.method === 'PATCH' ? apiError(409, 'last_admin') : undefined,
    );
    renderAdmin(<UsersView />);
    fireEvent.click(await screen.findByTestId('change-role'));

    const dialog = await screen.findByRole('dialog', { name: 'Смена роли' });
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    // Confirm stays disabled until another role is picked.
    expect(within(dialog).getByTestId('confirm-action')).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('role-select'), { target: { value: 'operator' } });
    fireEvent.click(within(dialog).getByTestId('confirm-action'));

    expect(
      await within(dialog).findByText(
        'Это последний активный администратор. Сначала назначьте другого.',
      ),
    ).toBeInTheDocument();
    const patches = api.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe(`/api/v1/admin/users/${IDS.user}`);
    expect(patches[0]?.body).toEqual({ role: 'operator' });
    expect(patches[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
    // The dialog stays open, so the admin can cancel instead.
    expect(screen.getByRole('dialog', { name: 'Смена роли' })).toBeInTheDocument();
  });

  it('confirms blocking, maps cannot_block_self, and unblocks without alarm colours', async () => {
    let attempt = 0;
    const api = installFakeApi(sessionHandler('admin'), list(adminUser()), (call) => {
      if (call.method !== 'PATCH') return undefined;
      attempt += 1;
      return attempt === 1
        ? apiError(409, 'cannot_block_self')
        : json(adminUser({ is_blocked: true }));
    });
    renderAdmin(<UsersView />, 'uz');
    fireEvent.click(await screen.findByTestId('toggle-block'));
    const dialog = await screen.findByRole('dialog', { name: 'Foydalanuvchini bloklash' });
    fireEvent.click(within(dialog).getByTestId('confirm-action'));
    expect(await within(dialog).findByText('O‘zingizni bloklab bo‘lmaydi.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId('confirm-action'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.filter((call) => call.method === 'PATCH')[1]?.body).toEqual({
      is_blocked: true,
    });
    expect(await screen.findByText('Foydalanuvchi bloklandi.')).toBeInTheDocument();
  });

  it('never sends a second request while one is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = installFakeApi(
      sessionHandler('admin'),
      list(adminUser({ is_blocked: true })),
      async (call) => {
        if (call.method !== 'PATCH') return undefined;
        await gate;
        return json(adminUser());
      },
    );
    renderAdmin(<UsersView />);
    fireEvent.click(await screen.findByTestId('toggle-block'));
    const confirm = await screen.findByTestId('confirm-action');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });
});

describe('userDisplayName', () => {
  it('falls back to the Telegram id and survives odd names', () => {
    expect(userDisplayName(adminUser({ first_name: '', last_name: null }), 'ID')).toBe('ID 555001');
    expect(userDisplayName(adminUser({ first_name: 'Jo', last_name: null }), 'ID')).toBe('Jo');
  });
});
