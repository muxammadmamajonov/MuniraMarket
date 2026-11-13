import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import type { Address } from '@/lib/address/address';
import { ADDRESS_STORAGE_ITEM, resetDeliveryAddressMemory } from '@/lib/address/storage';
import {
  autoloadYandexScript,
  houseResult,
  makeYMaps,
  mockGeocoderFetch,
  type FakeYMaps,
} from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { GEOCODE_DEBOUNCE_MS } from './address-picker';
import { DeliveryAddressCard } from './delivery-address-card';

const session = vi.hoisted(() => ({
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function savedAddress(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    label: 'Uy',
    lat: 41.3,
    lon: 69.2,
    street: 'Navoiy ko‘chasi',
    house: '30',
    apartment: null,
    entrance: null,
    floor: null,
    landmark: null,
    is_default: true,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

// Placeholder shape only; jsdom never fetches the script and the SDK is a fake.
const KEY = '00000000-0000-4000-8000-000000000000';

const HOME: Address = {
  lat: 41.311081,
  lon: 69.240562,
  street: 'Amir Temur ko‘chasi',
  house: '15',
  apartment: '4',
  entrance: '2',
  floor: '',
  landmark: 'Maktab yonida',
};

function renderCard(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={KEY} geocoderApiKey={KEY}>
          <DeliveryAddressCard />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

let fake: FakeYMaps;
let geocoder: ReturnType<typeof mockGeocoderFetch>;

beforeEach(() => {
  fake = makeYMaps();
  geocoder = mockGeocoderFetch();
  autoloadYandexScript('load', fake.api);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetYandexMapsLoader();
  delete window.ymaps3;
  window.localStorage.clear();
  resetDeliveryAddressMemory();
  document.body.style.overflow = '';
  session.status = 'anonymous';
  session.apiFetch.mockReset();
});

describe('DeliveryAddressCard', () => {
  it('prompts for an address when none is saved, and loads no map until tapped', () => {
    renderCard();
    const card = screen.getByTestId('delivery-address');
    expect(card).toHaveAttribute('data-state', 'unset');
    expect(card).toHaveTextContent('Yetkazish manzilini tanlang');
    expect(screen.queryByTestId('delivery-address-line')).toBeNull();
    expect(screen.queryByTestId('address-picker')).toBeNull();
    expect(fake.maps).toHaveLength(0);
  });

  it('shows the saved address on one line (uz), without the landmark', () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    renderCard();
    expect(screen.getByTestId('delivery-address')).toHaveAttribute('data-state', 'set');
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(
      'Amir Temur ko‘chasi, 15, 4-xonadon, 2-podyezd',
    );
    expect(screen.getByTestId('delivery-address')).not.toHaveTextContent('Maktab');
  });

  it('is localized (ru)', () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    renderCard('ru');
    expect(screen.getByRole('region', { name: 'Адрес доставки' })).toBeInTheDocument();
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(
      'Amir Temur ko‘chasi, 15, кв. 4, подъезд 2',
    );
  });

  it('ignores a corrupt saved value and prompts instead', () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, '{not json');
    renderCard();
    expect(screen.getByTestId('delivery-address')).toHaveAttribute('data-state', 'unset');
  });

  it('opens the map picker directly; saving persists the address and shows it', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Navoiy ko‘chasi', '30'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Yetkazish manzilini tanlang/ }));

    // Straight to the map and the form: no list or sheet in between.
    const picker = await screen.findByTestId('address-picker');
    expect(within(picker).getByTestId('address-form')).toBeInTheDocument();
    await within(picker).findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));

    vi.useFakeTimers();
    act(() => {
      fake.listeners[0]?.onActionStart?.();
      fake.maps[0]?.update({ location: { center: [69.2797, 41.3111], zoom: 16 } });
      fake.listeners[0]?.onActionEnd?.();
    });
    await act(() => vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS));
    expect(within(picker).getByRole('textbox', { name: /^Uy/ })).toHaveValue('30');
    fireEvent.click(within(picker).getByRole('button', { name: 'Shu yerga yetkazish' }));

    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toEqual({
      lat: 41.3111,
      lon: 69.2797,
      street: 'Navoiy ko‘chasi',
      house: '30',
      apartment: '',
      entrance: '',
      floor: '',
      landmark: '',
    });
    const card = screen.getByTestId('delivery-address');
    expect(card).toHaveAttribute('data-state', 'set');
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent('Navoiy ko‘chasi, 30');
    expect(card).toHaveTextContent('Manzil saqlandi');
    // The picker closes (it stays mounted for its exit animation, then unmounts).
    expect(screen.getByTestId('address-picker')).toHaveAttribute('data-closing', 'true');
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId('address-picker')).toBeNull();
  });

  it('editing starts the picker at the saved address', async () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Amir Temur ko‘chasi/ }));
    await screen.findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    expect(fake.maps[0]?.props.location.center).toEqual([69.240562, 41.311081]);
    expect(screen.getByRole('textbox', { name: /^Ko‘cha/ })).toHaveValue('Amir Temur ko‘chasi');
  });

  it('closing the picker without saving keeps the old address', async () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Amir Temur ko‘chasi/ }));
    await screen.findByTestId('map-canvas');
    fireEvent.click(screen.getAllByRole('button', { name: 'Orqaga' })[0] as HTMLElement);
    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toEqual(HOME);
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent('Amir Temur ko‘chasi');
  });

  it('signed in: starts from the saved default and offers saved addresses first', async () => {
    session.status = 'authenticated';
    session.apiFetch.mockResolvedValue(
      Response.json({
        items: [
          savedAddress(),
          savedAddress({
            id: 'a2',
            label: 'Ish',
            street: 'Bobur ko‘chasi',
            house: '7',
            is_default: false,
          }),
        ],
      }),
    );
    renderCard();
    // No address on this device yet: the saved default fills the card.
    await waitFor(() =>
      expect(screen.getByTestId('delivery-address-line')).toHaveTextContent('Navoiy ko‘chasi, 30'),
    );
    expect(session.apiFetch).toHaveBeenCalledWith('/me/addresses', { method: 'GET' });

    fireEvent.click(screen.getByRole('button', { name: /Navoiy ko‘chasi/ }));
    const chooser = await screen.findByTestId('address-chooser');
    const options = within(chooser).getAllByTestId('address-chooser-option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-pressed', 'true');
    expect(fake.maps).toHaveLength(0);

    fireEvent.click(options[1] as HTMLElement);
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent('Bobur ko‘chasi, 7');
    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toMatchObject({
      street: 'Bobur ko‘chasi',
      house: '7',
    });
  });

  it('signed in: "New address" in the chooser opens the map picker', async () => {
    session.status = 'authenticated';
    session.apiFetch.mockResolvedValue(Response.json({ items: [savedAddress()] }));
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId('delivery-address')).toHaveAttribute('data-state', 'set'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Navoiy ko‘chasi/ }));
    fireEvent.click(await screen.findByTestId('address-chooser-new'));
    expect(await screen.findByTestId('address-picker')).toBeInTheDocument();
  });
});
