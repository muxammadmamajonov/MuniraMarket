import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { AddressesView, labelKind } from './addresses-view';
import { ACTION_WIDTH, rubberBand, settle } from './swipe-row';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous',
  user: null,
  error: null,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function saved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    label: 'Uy',
    lat: 41.3,
    lon: 69.2,
    street: 'Navoiy ko‘chasi',
    house: '30',
    apartment: '12',
    entrance: null,
    floor: null,
    landmark: null,
    is_default: true,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const WORK = saved({
  id: 'a2',
  label: 'Ish',
  street: 'Bobur ko‘chasi',
  house: '7',
  is_default: false,
});

function renderView() {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <AddressesView />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
});

describe('swipe physics', () => {
  it('settles open after a short drag past half the action, or a quick flick', () => {
    expect(settle(-30, 0, 375)).toBe('closed');
    expect(settle(-ACTION_WIDTH / 2 - 1, 0, 375)).toBe('open');
    // A flick: little distance, high velocity.
    expect(settle(-20, -0.4, 375)).toBe('open');
    expect(settle(-ACTION_WIDTH, 0.4, 375)).toBe('closed');
  });

  it('a long drag past 60% of the row deletes outright', () => {
    expect(settle(-230, 0, 375)).toBe('delete');
  });

  it('resists past its limits instead of stopping dead', () => {
    expect(rubberBand(-50, 200)).toBe(-50);
    expect(rubberBand(-300, 200)).toBeGreaterThan(-300);
    expect(rubberBand(-300, 200)).toBeLessThan(-200);
    expect(rubberBand(40, 200)).toBe(10);
  });
});

describe('labelKind', () => {
  it('maps Home / Work in either language, anything else is a pin', () => {
    expect(labelKind('Uy')).toBe('home');
    expect(labelKind('дом')).toBe('home');
    expect(labelKind('Работа')).toBe('work');
    expect(labelKind('Onamnikida')).toBe('other');
    expect(labelKind(null)).toBe('other');
  });
});

describe('AddressesView', () => {
  it('has an empty state with an "add" action', async () => {
    session.apiFetch.mockResolvedValue(Response.json({ items: [] }));
    renderView();
    expect(await screen.findByText('Saqlangan manzillar yo‘q')).toBeInTheDocument();
    expect(screen.getByTestId('address-add')).toHaveAttribute('href', '/uz/profile/addresses/new');
  });

  it('lists saved addresses (default first, marked) linking to their editor', async () => {
    session.apiFetch.mockResolvedValue(Response.json({ items: [saved(), WORK] }));
    renderView();
    const rows = await screen.findAllByTestId('address-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Uy');
    expect(rows[0]).toHaveTextContent('Navoiy ko‘chasi, 30, 12-xonadon');
    expect(within(rows[0] as HTMLElement).getByTestId('address-default')).toHaveTextContent(
      'Asosiy',
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('address-default')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/uz/profile/addresses/a2',
    );
    expect(screen.getByTestId('address-add')).toBeInTheDocument();
  });

  it('keyboard / screen reader: the delete button opens the row on focus and deletes', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved(), WORK] }));
    renderView();
    const rows = await screen.findAllByTestId('address-row');
    const button = within(rows[1] as HTMLElement).getByRole('button', {
      name: '“Ish” manzilini o‘chirish',
    });
    act(() => button.focus());
    expect(within(rows[1] as HTMLElement).getByTestId('swipe-row')).toHaveAttribute(
      'data-open',
      'true',
    );

    session.apiFetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ items: [saved()] }));
    fireEvent.click(button);
    // Optimistic: gone at once.
    expect(screen.getAllByTestId('address-row')).toHaveLength(1);
    await waitFor(() =>
      expect(session.apiFetch).toHaveBeenCalledWith('/me/addresses/a2', { method: 'DELETE' }),
    );
    expect(await screen.findByText('Manzil o‘chirildi')).toBeInTheDocument();
  });

  it('a swipe left reveals delete; a tap elsewhere closes it; a failed delete comes back', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved(), WORK] }));
    renderView();
    const rows = await screen.findAllByTestId('address-row');
    const swipe = within(rows[0] as HTMLElement).getByTestId('swipe-row');
    const front = swipe.firstElementChild as HTMLElement;
    front.setPointerCapture = vi.fn();
    fireEvent.pointerDown(front, { pointerId: 1, clientX: 300, clientY: 20, timeStamp: 0 });
    fireEvent.pointerMove(front, { pointerId: 1, clientX: 260, clientY: 21, timeStamp: 40 });
    fireEvent.pointerMove(front, { pointerId: 1, clientX: 220, clientY: 22, timeStamp: 80 });
    fireEvent.pointerUp(front, { pointerId: 1, clientX: 220, clientY: 22, timeStamp: 90 });
    expect(swipe).toHaveAttribute('data-open', 'true');

    fireEvent.pointerDown(document.body);
    expect(swipe).toHaveAttribute('data-open', 'false');

    session.apiFetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'internal_error', message: 'x' } }, { status: 500 }),
    );
    fireEvent.click(within(rows[0] as HTMLElement).getByTestId('swipe-delete'));
    expect(await screen.findByText(/Manzilni o‘chirib bo‘lmadi/)).toBeInTheDocument();
    expect(screen.getAllByTestId('address-row')).toHaveLength(2);
  });

  it('a vertical drag is a scroll, not a swipe', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved()] }));
    renderView();
    const swipe = await screen.findByTestId('swipe-row');
    const front = swipe.firstElementChild as HTMLElement;
    front.setPointerCapture = vi.fn();
    fireEvent.pointerDown(front, { pointerId: 1, clientX: 300, clientY: 20, timeStamp: 0 });
    fireEvent.pointerMove(front, { pointerId: 1, clientX: 296, clientY: 80, timeStamp: 40 });
    fireEvent.pointerUp(front, { pointerId: 1, clientX: 296, clientY: 80, timeStamp: 50 });
    expect(swipe).toHaveAttribute('data-open', 'false');
    expect(front.setPointerCapture).not.toHaveBeenCalled();
  });

  it('at ten addresses the add action becomes the limit note', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      saved({ id: `a${String(i)}`, is_default: i === 0 }),
    );
    session.apiFetch.mockResolvedValue(Response.json({ items }));
    renderView();
    expect(await screen.findByText(/Ko‘pi bilan 10 ta manzil/)).toBeInTheDocument();
    expect(screen.queryByTestId('address-add')).toBeNull();
  });
});
