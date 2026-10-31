import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeApi,
  json,
  money,
  renderAdmin,
  sessionHandler,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { IDS, zone } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { ZonesView } from './zones-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/delivery/zones'));
afterEach(() => vi.unstubAllGlobals());

const list =
  (...zones: ReturnType<typeof zone>[]): FakeHandler =>
  (call) =>
    call.method === 'GET' && call.path === '/api/v1/admin/delivery/zones'
      ? json({ items: zones })
      : undefined;

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('ZonesView', () => {
  it('lists zones with fee, free threshold, hours and district names in the UI language', async () => {
    installFakeApi(
      sessionHandler('admin'),
      list(
        zone(),
        zone({ id: 'b', slug: 'b', free_delivery_threshold_uzs: null, is_active: false }),
      ),
    );
    renderAdmin(<ZonesView />, 'ru');
    const cards = await screen.findAllByTestId('zone-card');
    expect(within(cards[0]!).getByText('Чиланзарский')).toBeInTheDocument();
    expect(within(cards[0]!).getByText(money(15000, 'ru'))).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/Бесплатно от/)).toBeInTheDocument();
    expect(within(cards[0]!).getByText('09:00–21:00')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Бесплатной доставки нет')).toBeInTheDocument();
  });

  it('creates a zone: empty free threshold means never free, districts are a multi-select', async () => {
    const api = installFakeApi(sessionHandler('admin'), list(zone()), (call) =>
      call.method === 'POST' ? json(zone({ id: 'new' }), { status: 201 }) : undefined,
    );
    renderAdmin(<ZonesView />);
    fireEvent.click(await screen.findByTestId('new-zone'));
    await screen.findByRole('dialog', { name: 'Новая зона' });
    // A district that belongs to another zone cannot be ticked.
    expect(screen.getByTestId('zone-district-chilonzor')).toBeDisabled();

    type('zone-name-uz', 'Shimol');
    type('zone-name-ru', 'Север');
    type('zone-slug', 'north');
    type('zone-fee', '20000');
    type('zone-min-order', '0');
    type('zone-opens-at', '08:00');
    type('zone-closes-at', '20:00');
    fireEvent.click(screen.getByTestId('zone-district-yunusobod'));
    fireEvent.click(screen.getByTestId('zone-district-mirobod'));
    fireEvent.click(screen.getByTestId('zone-save'));

    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
      slug: 'north',
      name_uz: 'Shimol',
      name_ru: 'Север',
      delivery_fee_uzs: 20000,
      free_delivery_threshold_uzs: null,
      min_order_uzs: 0,
      opens_at: '08:00',
      closes_at: '20:00',
      sort_order: 0,
      is_active: true,
      districts: ['yunusobod', 'mirobod'],
    });
  });

  it('requires a district and opening before closing', async () => {
    const api = installFakeApi(sessionHandler('admin'), list());
    renderAdmin(<ZonesView />);
    fireEvent.click(await screen.findByTestId('new-zone'));
    await screen.findByRole('dialog');
    type('zone-opens-at', '21:00');
    type('zone-closes-at', '09:00');
    fireEvent.click(screen.getByTestId('zone-save'));
    expect(await screen.findByText('Выберите хотя бы один район.')).toBeInTheDocument();
    expect(screen.getByTestId('zone-closes-at')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('names the district on a 409 district_taken, in uz and ru', async () => {
    installFakeApi(sessionHandler('admin'), list(), (call) =>
      call.method === 'POST'
        ? json(
            { error: { code: 'district_taken', message: 'x', district: 'yunusobod' } },
            { status: 409 },
          )
        : undefined,
    );
    renderAdmin(<ZonesView />, 'uz');
    fireEvent.click(await screen.findByTestId('new-zone'));
    await screen.findByRole('dialog');
    type('zone-name-uz', 'A');
    type('zone-name-ru', 'А');
    type('zone-slug', 'a');
    type('zone-fee', '1');
    fireEvent.click(screen.getByTestId('zone-district-yunusobod'));
    fireEvent.click(screen.getByTestId('zone-save'));
    expect(
      await screen.findByText('«Yunusobod» tumani boshqa hududga biriktirilgan.'),
    ).toBeInTheDocument();
  });

  it('sends only what changed when editing, and maps zone_in_use on delete', async () => {
    const api = installFakeApi(sessionHandler('admin'), list(zone()), (call) =>
      call.method === 'PATCH'
        ? json(zone({ delivery_fee_uzs: 18000 }))
        : call.method === 'DELETE'
          ? json({ error: { code: 'zone_in_use', message: 'x' } }, { status: 409 })
          : undefined,
    );
    renderAdmin(<ZonesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Изменить: Центр' }));
    await screen.findByRole('dialog', { name: 'Редактирование зоны' });
    type('zone-fee', '18000');
    fireEvent.click(screen.getByTestId('zone-save'));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(api.calls.find((call) => call.method === 'PATCH')?.path).toBe(
      `/api/v1/admin/delivery/zones/${IDS.zone}`,
    );
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      delivery_fee_uzs: 18000,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить: Центр' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить зону' });
    fireEvent.click(within(dialog).getByTestId('confirm-action'));
    expect(
      await within(dialog).findByText(/К зоне привязаны заказы или слоты/),
    ).toBeInTheDocument();
  });
});
