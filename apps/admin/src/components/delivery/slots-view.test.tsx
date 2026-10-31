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
import { IDS, slot, zone } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { SlotsView } from './slots-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/delivery/slots'));
afterEach(() => vi.unstubAllGlobals());

const base = (slots = [slot()]): FakeHandler[] => [
  sessionHandler('admin'),
  (call) => (call.path === '/api/v1/admin/delivery/zones' ? json({ items: [zone()] }) : undefined),
  (call) =>
    call.method === 'GET' && call.path.startsWith('/api/v1/admin/delivery/slots?')
      ? json({ items: slots, truncated: false })
      : undefined,
];

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

async function openCreate() {
  const open = await screen.findByTestId('new-slot');
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  return screen.findByRole('dialog', { name: 'Новый слот' });
}

describe('SlotsView: list', () => {
  it('groups slots by date and shows capacity, reserved and remaining', async () => {
    const api = installFakeApi(
      ...base([
        slot(),
        slot({ id: 'b', slot_date: '2026-11-03', capacity: 2, reserved_count: 2, remaining: 0 }),
      ]),
    );
    renderAdmin(<SlotsView />);
    const rows = await screen.findAllByTestId('slot-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByRole('heading', { name: '02.11.2026' })).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Занято: 4 из 10/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Свободно: 6/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Заполнен/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('14:00–16:00')).toBeInTheDocument();
    // A default window (today + 13 days) is requested, with no zone filter.
    expect(api.to('/api/v1/admin/delivery/slots')[0]?.path).toMatch(
      /date_from=\d{4}-\d{2}-\d{2}&date_to=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('filters by zone and date range from the URL', async () => {
    setLocation(`/ru/delivery/slots?zone=${IDS.zone}&from=2026-11-01&to=2026-11-05`);
    const api = installFakeApi(...base([]));
    renderAdmin(<SlotsView />);
    await screen.findByText('Для выбранной зоны и дат слотов нет.');
    expect(api.to('/api/v1/admin/delivery/slots')[0]?.path).toBe(
      `/api/v1/admin/delivery/slots?date_from=2026-11-01&date_to=2026-11-05&zone_id=${IDS.zone}`,
    );
  });

  it('toggles active with a PATCH and reloads', async () => {
    const api = installFakeApi(...base(), (call) =>
      call.method === 'PATCH' ? json(slot({ is_active: false })) : undefined,
    );
    renderAdmin(<SlotsView />);
    fireEvent.click(await screen.findByRole('button', { name: '14:00–16:00: активность' }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ is_active: false });
  });
});

describe('SlotsView: create form', () => {
  it('defaults the cut-off to two hours before the start (Tashkent) and follows start changes', async () => {
    installFakeApi(...base());
    renderAdmin(<SlotsView />);
    await openCreate();
    type('slot-date', '2026-11-02');
    type('slot-starts-at', '14:00');
    expect(screen.getByTestId('slot-cutoff')).toHaveValue('2026-11-02T12:00');
    type('slot-starts-at', '09:30');
    expect(screen.getByTestId('slot-cutoff')).toHaveValue('2026-11-02T07:30');
    // Crossing midnight works too.
    type('slot-starts-at', '01:00');
    expect(screen.getByTestId('slot-cutoff')).toHaveValue('2026-11-01T23:00');
    // A cut-off the admin typed is kept when the start changes.
    type('slot-cutoff', '2026-11-02T06:00');
    type('slot-starts-at', '15:00');
    expect(screen.getByTestId('slot-cutoff')).toHaveValue('2026-11-02T06:00');
  });

  it('posts ISO times with the +05:00 offset', async () => {
    const api = installFakeApi(...base(), (call) =>
      call.method === 'POST' ? json(slot(), { status: 201 }) : undefined,
    );
    renderAdmin(<SlotsView />);
    await openCreate();
    type('slot-zone', IDS.zone);
    type('slot-date', '2026-11-02');
    type('slot-starts-at', '14:00');
    type('slot-ends-at', '16:00');
    type('slot-capacity', '12');
    fireEvent.click(screen.getByTestId('slot-create'));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
      zone_id: IDS.zone,
      slot_date: '2026-11-02',
      starts_at: '14:00',
      ends_at: '16:00',
      capacity: 12,
      cutoff_at: '2026-11-02T12:00:00+05:00',
      is_active: true,
    });
    expect(await screen.findByText('Слот создан.')).toBeInTheDocument();
  });

  it('validates before sending: zone, times, capacity and a cut-off after the start', async () => {
    const api = installFakeApi(...base());
    renderAdmin(<SlotsView />);
    await openCreate();
    type('slot-ends-at', '13:00'); // before the 14:00 start
    type('slot-capacity', '-1');
    type('slot-cutoff', '2026-12-01T10:00');
    type('slot-date', '2026-11-02');
    fireEvent.click(screen.getByTestId('slot-create'));
    expect(await screen.findByText('Выберите зону.')).toBeInTheDocument();
    for (const id of ['slot-zone', 'slot-ends-at', 'slot-capacity', 'slot-cutoff']) {
      expect(screen.getByTestId(id)).toHaveAttribute('aria-invalid', 'true');
    }
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it.each([['slot_exists', 'Для этой зоны на эту дату и время начала слот уже есть.']])(
    'maps %s to a message in the form',
    async (code, text) => {
      installFakeApi(...base(), (call) =>
        call.method === 'POST' ? apiError(409, code) : undefined,
      );
      renderAdmin(<SlotsView />);
      await openCreate();
      type('slot-zone', IDS.zone);
      type('slot-date', '2026-11-02');
      fireEvent.click(screen.getByTestId('slot-create'));
      expect(await screen.findByText(text)).toBeInTheDocument();
    },
  );
});

describe('SlotsView: edit and delete', () => {
  it('maps capacity_below_reserved to the capacity field', async () => {
    installFakeApi(...base(), (call) =>
      call.method === 'PATCH' ? apiError(409, 'capacity_below_reserved') : undefined,
    );
    renderAdmin(<SlotsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Изменить: 02\.11\.2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Редактирование слота' });
    // Zone, date and time are locked while editing.
    expect(within(dialog).getByTestId('slot-date')).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('slot-capacity'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByTestId('slot-create'));
    expect(
      await within(dialog).findByText(
        'Вместимость не может быть меньше числа забронированных мест.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId('slot-capacity')).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps slot_in_use when deleting, inside the confirmation', async () => {
    installFakeApi(...base(), (call) =>
      call.method === 'DELETE' ? apiError(409, 'slot_in_use') : undefined,
    );
    renderAdmin(<SlotsView />);
    fireEvent.click(await screen.findByRole('button', { name: /Удалить: 02\.11\.2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить слот' });
    fireEvent.click(within(dialog).getByTestId('confirm-action'));
    expect(
      await within(dialog).findByText(/В слоте есть забронированные заказы/),
    ).toBeInTheDocument();
  });
});
