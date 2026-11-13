import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import type { Address } from '@/lib/address/address';
import { AddressEditorView } from './address-editor-view';

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

const PICKED: Address = {
  lat: 41.311081,
  lon: 69.240562,
  street: 'Amir Temur ko‘chasi',
  house: '15',
  apartment: '4',
  entrance: '',
  floor: '',
  landmark: 'Maktab yonida',
};

// The real picker (Yandex map + form) has its own tests; here it is the same contract, faked.
vi.mock('../address-picker', () => ({
  AddressPicker: ({
    open,
    onSave,
    initial,
  }: {
    open: boolean;
    onSave: (a: Address) => void;
    initial: Address | null;
  }) =>
    open ? (
      <div data-testid="fake-picker" data-initial={initial?.street ?? ''}>
        <button type="button" onClick={() => onSave(PICKED)}>
          pick
        </button>
      </div>
    ) : null,
}));

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'authenticated' | 'anonymous',
  user: null,
  error: null,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function saved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    label: 'Onamnikida',
    lat: 41.3,
    lon: 69.2,
    street: 'Navoiy ko‘chasi',
    house: '30',
    apartment: null,
    entrance: null,
    floor: null,
    landmark: null,
    is_default: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function renderEditor(id: string | null) {
  return render(
    <LocaleProvider locale="uz">
      <AddressEditorView addressId={id} />
    </LocaleProvider>,
  );
}

function bodyOf(call: number): unknown {
  return JSON.parse(String(session.apiFetch.mock.calls[call]?.[1]?.body ?? 'null'));
}

beforeEach(() => {
  session.apiFetch.mockReset();
  nav.back.mockReset();
  nav.replace.mockReset();
});

describe('AddressEditorView', () => {
  it('new: needs a map point, then saves it as the default first address named "Uy"', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [] }));
    renderEditor(null);
    fireEvent.click(await screen.findByTestId('address-save'));
    expect(screen.getByTestId('address-notice')).toHaveTextContent(
      'Avval manzilni xaritada belgilang.',
    );
    expect(session.apiFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('address-choose-on-map'));
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    expect(screen.getByTestId('address-summary')).toHaveTextContent(
      'Amir Temur ko‘chasi, 15, 4-xonadon',
    );
    expect(screen.getByTestId('address-label-home')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('address-default-switch')).toHaveAttribute('aria-checked', 'true');

    session.apiFetch.mockResolvedValueOnce(Response.json(saved({ id: 'new' }), { status: 201 }));
    fireEvent.click(screen.getByTestId('address-save'));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/uz/profile/addresses'));
    expect(session.apiFetch.mock.calls[1]?.[0]).toBe('/me/addresses');
    expect(session.apiFetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(bodyOf(1)).toEqual({
      lat: 41.311081,
      lon: 69.240562,
      street: 'Amir Temur ko‘chasi',
      house: '15',
      apartment: '4',
      landmark: 'Maktab yonida',
      label: 'Uy',
      is_default: true,
    });
  });

  it('edit: starts from the saved address and its own name; PUT keeps the default flag', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved()] }));
    renderEditor('a1');
    expect(await screen.findByTestId('address-summary')).toHaveTextContent('Navoiy ko‘chasi, 30');
    expect(screen.getByTestId('address-label-other')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('address-label-input')).toHaveValue('Onamnikida');

    fireEvent.click(screen.getByTestId('address-change-on-map'));
    expect(screen.getByTestId('fake-picker')).toHaveAttribute('data-initial', 'Navoiy ko‘chasi');
    fireEvent.click(screen.getByTestId('address-label-work'));

    session.apiFetch.mockResolvedValueOnce(Response.json(saved({ label: 'Ish' })));
    fireEvent.click(screen.getByTestId('address-save'));
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(session.apiFetch.mock.calls[1]?.[0]).toBe('/me/addresses/a1');
    expect(session.apiFetch.mock.calls[1]?.[1]?.method).toBe('PUT');
    expect(bodyOf(1)).toMatchObject({ label: 'Ish', street: 'Navoiy ko‘chasi' });
    expect(bodyOf(1)).not.toHaveProperty('is_default');
  });

  it('edit: delete asks first, then removes it', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved()] }));
    renderEditor('a1');
    fireEvent.click(await screen.findByTestId('address-delete'));
    expect(screen.getByRole('dialog', { name: 'Manzil o‘chirilsinmi?' })).toBeInTheDocument();
    session.apiFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fireEvent.click(screen.getByTestId('address-delete-confirm'));
    await waitFor(() =>
      expect(session.apiFetch).toHaveBeenCalledWith('/me/addresses/a1', { method: 'DELETE' }),
    );
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/uz/profile/addresses'));
  });

  it('says so for an address that is not the customer’s (or gone)', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved()] }));
    renderEditor('someone-elses');
    expect(await screen.findByText('Bunday manzil topilmadi.')).toBeInTheDocument();
  });

  it('explains the ten-address limit', async () => {
    session.apiFetch.mockResolvedValueOnce(Response.json({ items: [saved()] }));
    renderEditor(null);
    fireEvent.click(await screen.findByTestId('address-choose-on-map'));
    fireEvent.click(screen.getByRole('button', { name: 'pick' }));
    session.apiFetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 'address_limit_reached', message: 'limit' } },
        { status: 409 },
      ),
    );
    fireEvent.click(screen.getByTestId('address-save'));
    expect(await screen.findByText(/Ko‘pi bilan 10 ta manzil/)).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
