import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, installFakeApi, json, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { page } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { UsersView } from '../users/users-view';
import { AdminOnly } from './resource-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/users'));
afterEach(() => vi.unstubAllGlobals());

describe('admin-only pages', () => {
  it('show an operator "permission denied" and never mount the page or call the API', async () => {
    const api = installFakeApi(sessionHandler('operator'));
    renderAdmin(
      <AdminOnly>
        <UsersView />
      </AdminOnly>,
    );
    expect(await screen.findByTestId('permission-denied')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Недостаточно прав' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
  });

  it('render the page for an admin', async () => {
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith('/api/v1/admin/users') ? json(page([])) : undefined,
    );
    renderAdmin(
      <AdminOnly>
        <UsersView />
      </AdminOnly>,
    );
    expect(await screen.findByText('Пользователей нет.')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-denied')).not.toBeInTheDocument();
  });

  it('treat a 403 from the API (role changed meanwhile) the same way', async () => {
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith('/api/v1/admin/users') ? apiError(403, 'forbidden') : undefined,
    );
    renderAdmin(<UsersView />, 'uz');
    expect(await screen.findByTestId('permission-denied')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Huquq yetarli emas' })).toBeInTheDocument();
  });
});

describe('data screen states', () => {
  it('shows a skeleton, then an error with retry that works, and a rate-limit message', async () => {
    let calls = 0;
    installFakeApi(sessionHandler('admin'), (call) => {
      if (!call.path.startsWith('/api/v1/admin/users')) return undefined;
      calls += 1;
      if (calls === 1) return apiError(429, 'rate_limited');
      if (calls === 2) return apiError(503, 'service_unavailable');
      return json(page([]));
    });
    renderAdmin(<UsersView />);
    expect(
      await screen.findByText('Слишком много запросов. Попробуйте чуть позже.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText(/Сервис временно недоступен/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Пользователей нет.')).toBeInTheDocument();
  });
});
