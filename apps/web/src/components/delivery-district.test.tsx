import type { DeliveryZone } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { zone } from '@/lib/checkout/test-fixtures';
import {
  DISTRICT_STORAGE_ITEM,
  resetDistrictPreferenceMemory,
} from '@/lib/delivery/district-preference';
import { autoloadYandexScript, makeYMaps, toponym } from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { DeliveryDistrict } from './delivery-district';

const ZONES: DeliveryZone[] = [
  zone(),
  zone({
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'demo-chekka',
    name_uz: 'Demo chekka zona',
    name_ru: 'Демо окраинная зона',
    delivery_fee_uzs: 25000,
    free_delivery_threshold_uzs: null,
    opens_at: '09:00',
    closes_at: '20:00',
    districts: [{ code: 'chilonzor', name_uz: 'Chilonzor', name_ru: 'Чиланзар' }],
  }),
];

// Placeholder shape only; nothing is loaded from Yandex in tests.
const KEY = '00000000-0000-4000-8000-000000000000';

function renderChooser(
  zones: DeliveryZone[] | null = ZONES,
  locale: 'uz' | 'ru' = 'uz',
  apiKey: string | null = null,
) {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={apiKey}>
          <button>before</button>
          <DeliveryDistrict zones={zones} />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetDistrictPreferenceMemory();
  resetYandexMapsLoader();
  delete window.ymaps3;
  uninstallWebApp();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('DeliveryDistrict', () => {
  it('before a choice, is one button asking for the delivery address, without claiming a location', () => {
    renderChooser();
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unset');
    expect(card.textContent).not.toMatch(/aniqlandi|определ|detected/i);
    const buttons = within(card).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Yetkazib berish manzilini tanlang');
  });

  it('opens a sheet, selects a district, and shows only the district and "Change"', () => {
    renderChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Yetkazib berish manzilini tanlang' }));
    const dialog = screen.getByRole('dialog', { name: 'Yetkazib berish manzili' });
    // One list of districts: zones (pricing tiers) and their fees are not shown.
    expect(within(dialog).getAllByRole('group')).toHaveLength(1);
    expect(dialog.textContent).not.toMatch(/so‘m|сум|bepul|\d{2}:\d{2}/);
    expect(within(dialog).getByRole('button', { name: 'Xaritada belgilash' })).toBeVisible();

    // Nothing is chosen yet, so "Tanlash" waits for a pick.
    const confirm = within(dialog).getByRole('button', { name: 'Tanlash' });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Yunusobod' }));
    fireEvent.click(confirm);

    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('yunusobod');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'set');
    expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Yunusobod');
    expect(card.textContent).not.toMatch(/so‘m|bepul|Yetkazish vaqti|\d{2}:\d{2}/);
    expect(screen.getByText('Tanlangan tuman: Yunusobod')).toBeInTheDocument();
  });

  it('shows no fee, free-from amount or hours in Russian either', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'chilonzor');
    renderChooser(ZONES, 'ru');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveTextContent('Чиланзар');
    expect(card.textContent).not.toMatch(/сум|Бесплатно|Время доставки|\d{2}:\d{2}/);
    expect(screen.getByRole('button', { name: 'Изменить: Доставка, Чиланзар' })).toBeVisible();
  });

  it('changes the district, and closing without confirming keeps the old one', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'mirobod');
    renderChooser();
    const change = screen.getByRole('button', { name: /O‘zgartirish/ });

    fireEvent.click(change);
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Chilonzor' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('mirobod');

    act(() => {
      fireEvent.click(change);
    });
    dialog = screen.getAllByRole('dialog').at(-1) as HTMLElement;
    // Reopening starts again from the saved choice.
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Chilonzor' }));
    fireEvent.submit(within(dialog).getByTestId('district-sheet'));
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('chilonzor');
    expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Chilonzor');
  });

  it('falls back to the prompt when the remembered district is no longer served', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'bektemir');
    renderChooser();
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unset');
    expect(card).toHaveTextContent('Avval tanlangan tumanga hozir yetkazilmaydi.');
  });

  it('ignores a tampered stored value', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, '<img src=x>');
    renderChooser();
    expect(screen.getByTestId('delivery-district')).toHaveAttribute('data-state', 'unset');
  });

  it('keeps browsing possible when zones could not be loaded', () => {
    renderChooser(null, 'ru');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unavailable');
    expect(card).toHaveTextContent('Не удалось загрузить районы.');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('says so when no zone delivers', () => {
    renderChooser([]);
    expect(screen.getByTestId('delivery-district')).toHaveAttribute('data-state', 'no-zones');
  });
});

describe('DeliveryDistrict: map step', () => {
  function openMapFromSheet() {
    fireEvent.click(
      screen.getByRole('button', { name: /Yetkazib berish manzilini tanlang|O‘zgartirish/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xaritada belgilash' }));
    return screen.getByTestId('address-picker');
  }

  it('without a key, the map step falls back and returns to the district list', () => {
    renderChooser();
    const picker = openMapFromSheet();
    expect(within(picker).getByTestId('map-unavailable')).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }));
    expect(screen.getByRole('dialog', { name: 'Yetkazib berish manzili' })).toBeInTheDocument();
  });

  it('a served result selects its district; only the code is stored, nothing else leaves', async () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'yunusobod');
    const fake = makeYMaps();
    fake.search.mockResolvedValue([toponym('Chilonzor tumani', 'Toshkent, O‘zbekiston')]);
    autoloadYandexScript('load', fake.api);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    const href = window.location.href;

    renderChooser(ZONES, 'uz', KEY);
    openMapFromSheet();
    const canvas = await screen.findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    const result = await screen.findByTestId('map-result');
    fireEvent.click(within(result).getByRole('button', { name: 'Chilonzor tumanini tanlash' }));

    // Back on the storefront with the new district; the sheet does not reopen.
    await waitFor(() =>
      expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Chilonzor'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Yetkazib berish manzili' })).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByTestId('address-picker')).toBeNull());

    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('chilonzor');
    expect(Object.keys({ ...window.localStorage })).toEqual([DISTRICT_STORAGE_ITEM]);
    expect(window.sessionStorage).toHaveLength(0);
    expect(document.cookie).not.toMatch(/69\.|41\./);
    expect(window.location.href).toBe(href);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'sendBeacon');
  });

  it('a failed lookup leads back to the list and changes nothing', async () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'yunusobod');
    const fake = makeYMaps();
    fake.search.mockRejectedValue(new Error('403'));
    autoloadYandexScript('load', fake.api);
    renderChooser(ZONES, 'uz', KEY);
    openMapFromSheet();
    await screen.findByTestId('map-canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    const result = await screen.findByTestId('map-result');
    expect(result).toHaveAttribute('data-status', 'lookup-failed');
    fireEvent.click(within(result).getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }));
    expect(screen.getByRole('dialog', { name: 'Yetkazib berish manzili' })).toBeInTheDocument();
    expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Yunusobod');
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('yunusobod');
  });

  it('in Telegram, asks for fullscreen only when the map is opened, and leaves it after', async () => {
    const webApp = makeWebApp({
      isVersionAtLeast: vi.fn(() => true),
      requestFullscreen: vi.fn(),
      exitFullscreen: vi.fn(),
      isFullscreen: false,
    });
    installWebApp(webApp);
    renderChooser();
    expect(webApp.requestFullscreen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yetkazib berish manzilini tanlang' }));
    expect(webApp.requestFullscreen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Xaritada belgilash' }));
    expect(webApp.requestFullscreen).toHaveBeenCalledTimes(1);

    // The client switched (Telegram reports it); closing the map leaves fullscreen again.
    Object.defineProperty(webApp, 'isFullscreen', { value: true, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Orqaga' }));
    expect(webApp.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('in Telegram, a refused fullscreen changes nothing and is not "undone"', () => {
    const webApp = makeWebApp({
      isVersionAtLeast: vi.fn(() => true),
      requestFullscreen: vi.fn(),
      exitFullscreen: vi.fn(),
      isFullscreen: false,
    });
    installWebApp(webApp);
    renderChooser();
    openMapFromSheet();
    // `fullscreenFailed`: isFullscreen stays false.
    fireEvent.click(screen.getByRole('button', { name: 'Orqaga' }));
    expect(webApp.exitFullscreen).not.toHaveBeenCalled();
  });

  it('on clients without fullscreen support, opens the map normally', () => {
    const webApp = makeWebApp({ isVersionAtLeast: vi.fn(() => false), requestFullscreen: vi.fn() });
    installWebApp(webApp);
    renderChooser();
    const picker = openMapFromSheet();
    expect(webApp.requestFullscreen).not.toHaveBeenCalled();
    expect(picker).toBeInTheDocument();
  });
});
