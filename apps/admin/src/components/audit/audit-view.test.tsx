import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { openOptions } from '@/test-utils/select';
import { auditEntry, page } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { AuditView } from './audit-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/audit'));
afterEach(() => vi.unstubAllGlobals());

describe('AuditView', () => {
  it('lists entries newest first as received and renders details as "field: from → to"', async () => {
    const api = installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith('/api/v1/admin/audit')
        ? json(
            page([
              auditEntry(),
              auditEntry({
                id: 'b',
                action: 'catalog.import',
                entity_type: 'catalog',
                entity_id: 'x',
                actor_user_id: null,
                details: { rows: 12, creates: 3, source: 'csv', has_reason: true },
              }),
              auditEntry({
                id: 'c',
                action: 'user.block',
                entity_type: 'user',
                details: { changes: { is_blocked: { from: false, to: true } } },
              }),
              auditEntry({
                id: 'd',
                action: 'weird.new_action',
                details: { changes: { old_price_uzs: { from: null, to: 5 } }, nested: { a: 1 } },
              }),
            ]),
          )
        : undefined,
    );
    renderAdmin(<AuditView />);
    const rows = await screen.findAllByTestId('audit-row');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Товар изменён')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('price_uzs')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('price_uzs: 25000 → 30000');
    expect(rows[1]).toHaveTextContent('Импорт каталога');
    expect(rows[1]).toHaveTextContent('Система');
    expect(rows[1]).toHaveTextContent('строк: 12');
    expect(rows[1]).toHaveTextContent('причина указана: Да');
    expect(rows[2]).toHaveTextContent('is_blocked: Нет → Да');
    // Unknown actions show their code; null shows a dash; objects are skipped, never "[object Object]".
    expect(rows[3]).toHaveTextContent('weird.new_action');
    expect(rows[3]).toHaveTextContent('old_price_uzs: — → 5');
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(api.to('/api/v1/admin/audit')[0]?.path).toBe('/api/v1/admin/audit?page=1&page_size=25');
  });

  it('filters by entity type and action through the URL', async () => {
    const api = installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith('/api/v1/admin/audit') ? json(page([])) : undefined,
    );
    renderAdmin(<AuditView />);
    await screen.findByText('В журнале пока нет записей.');
    act(() => setLocation('/ru/audit?entity_type=user&action=user.block&page=2'));
    await waitFor(() =>
      expect(api.to('/api/v1/admin/audit').at(-1)?.path).toBe(
        '/api/v1/admin/audit?page=2&page_size=25&entity_type=user&action=user.block',
      ),
    );
    expect(await screen.findByText('По фильтрам записей не найдено.')).toBeInTheDocument();
    // The action list narrows to the chosen entity type.
    const actions = openOptions('audit-action-filter');
    expect(actions.map((option) => option.textContent)).toEqual([
      'Все действия',
      'Роль изменена',
      'Пользователь заблокирован',
      'Пользователь разблокирован',
    ]);
  });

  it('renders old rows of entity types the app no longer has by their raw codes', async () => {
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith('/api/v1/admin/audit')
        ? json(
            page([
              auditEntry({
                action: 'retired.delete',
                entity_type: 'retired',
                entity_id: 'r1',
                details: { changes: { name_ru: { from: 'A', to: null } }, legacy_count: 3 },
              }),
            ]),
          )
        : undefined,
    );
    renderAdmin(<AuditView />);
    const row = await screen.findByTestId('audit-row');
    expect(row).toHaveTextContent('retired.delete');
    expect(row).toHaveTextContent('retired');
    expect(row).toHaveTextContent('name_ru: A → —');
    expect(row).toHaveTextContent('legacy_count: 3');
    expect(document.body.textContent).not.toContain('undefined');
  });
});
