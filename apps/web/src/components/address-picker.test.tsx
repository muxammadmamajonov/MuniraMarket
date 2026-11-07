import type { DeliveryZone } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { farZone, zone } from '@/lib/checkout/test-fixtures';
import { autoloadYandexScript, makeYMaps, toponym, type FakeYMaps } from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { AddressPicker, TASHKENT_CENTER } from './address-picker';

// Placeholder shape only; jsdom never fetches the script and the SDK is a fake.
const KEY = '00000000-0000-4000-8000-000000000000';

// Served: yunusobod, mirobod (demo central zone), chilonzor (demo outer zone, free delivery).
const ZONES: DeliveryZone[] = [zone(), farZone()];

function renderPicker({
  apiKey = KEY,
  locale = 'uz',
  onClose = vi.fn(),
  onChoose = vi.fn(),
  zones = ZONES,
}: {
  apiKey?: string | null;
  locale?: 'uz' | 'ru';
  onClose?: () => void;
  onChoose?: (code: string) => void;
  zones?: DeliveryZone[];
} = {}) {
  const view = render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={apiKey}>
          <button>trigger</button>
          <AddressPicker open onClose={onClose} zones={zones} onChoose={onChoose} />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
  return { onClose, onChoose, unmount: view.unmount };
}

let fake: FakeYMaps;

beforeEach(() => {
  fake = makeYMaps();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetYandexMapsLoader();
  delete window.ymaps3;
  uninstallWebApp();
  document.body.style.overflow = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function ready(options: Parameters<typeof renderPicker>[0] = {}) {
  autoloadYandexScript('load', fake.api);
  const result = renderPicker(options);
  await screen.findByTestId('map-canvas');
  await waitFor(() => expect(fake.maps).toHaveLength(1));
  return result;
}

async function confirmPoint(name = 'Shu yerga yetkazish') {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByTestId('map-result');
}

describe('AddressPicker: without a key', () => {
  it('shows its own fallback, loads nothing and offers the district list', () => {
    const append = vi.spyOn(document.head, 'append');
    const { onClose } = renderPicker({ apiKey: null });
    const dialog = screen.getByRole('dialog', { name: 'Xaritada belgilash' });
    expect(within(dialog).getByTestId('map-unavailable')).toHaveTextContent(
      'Xarita bu yerda ishlamaydi',
    );
    expect(within(dialog).queryByTestId('map-confirm')).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(document.querySelector('script[data-mm-yandex-maps]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is localized', () => {
    renderPicker({ apiKey: null, locale: 'ru' });
    expect(screen.getByRole('dialog', { name: 'Указать на карте' })).toHaveTextContent(
      'Карта здесь не работает',
    );
  });
});

describe('AddressPicker: loading and errors', () => {
  it('shows a loading state; "Deliver here" waits for the map, the list is always reachable', () => {
    autoloadYandexScript('hang');
    const { onClose } = renderPicker();
    expect(screen.getByTestId('map-loading')).toHaveTextContent('Xarita yuklanmoqda…');
    expect(screen.getByTestId('map-confirm')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a working retry', async () => {
    const failing = autoloadYandexScript('error');
    renderPicker();
    const error = await screen.findByTestId('map-error');
    expect(error).toHaveTextContent('Xaritani yuklab bo‘lmadi');

    failing.mockRestore();
    autoloadYandexScript('load', fake.api);
    fireEvent.click(within(error).getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByTestId('map-canvas')).toBeInTheDocument();
  });

  it('says "offline" when there is no connection', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderPicker();
    expect(await screen.findByTestId('map-error')).toHaveTextContent('Internet aloqasi yo‘q');
  });
});

describe('AddressPicker: the map and the centre pin', () => {
  it('starts centred on Tashkent with the Yandex layers, a gesture listener and our pin', async () => {
    await ready();
    expect(fake.maps[0]?.props.location).toEqual({ center: TASHKENT_CENTER, zoom: 12 });
    expect(fake.maps[0]?.children).toHaveLength(3);
    expect(fake.listeners).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Yetkazish nuqtasi xarita markazida' })).toBeVisible();
  });

  it('looks nothing up until "Deliver here" is pressed', async () => {
    await ready();
    fireEvent.keyDown(screen.getByTestId('map-canvas'), { key: 'ArrowLeft' });
    act(() => fake.listeners[0]?.onActionStart?.());
    expect(fake.search).not.toHaveBeenCalled();
  });

  it('cleans the map up when it closes', async () => {
    const { unmount } = await ready();
    const map = fake.maps[0];
    unmount();
    expect(map?.destroy).toHaveBeenCalled();
  });
});

describe('AddressPicker: delivery result after "Deliver here"', () => {
  it('served: real zone rules, a demo hint, and choosing saves only the district', async () => {
    fake.search.mockResolvedValue([
      toponym('Bunyodkor ko‘chasi, 15', 'Toshkent, O‘zbekiston'),
      toponym('Chilonzor tumani', 'Toshkent, O‘zbekiston'),
    ]);
    const { onChoose } = await ready();
    const result = await confirmPoint();

    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(fake.search.mock.calls[0]?.[0].text).toBe('69.279700,41.311100');
    expect(result).toHaveAttribute('data-status', 'served');
    expect(within(result).getByRole('heading')).toHaveTextContent(
      'Chilonzor tumaniga yetkazib beramiz',
    );
    expect(within(result).getByRole('heading')).toHaveFocus();
    expect(result).toHaveTextContent('Demo chekka zona');
    expect(within(result).getByTestId('demo-badge')).toHaveTextContent('Demo');
    expect(within(result).getByTestId('demo-note')).toHaveTextContent('admin panelda');
    // farZone: fee 0, no threshold, minimum 100 000, 09:00–21:00, open now.
    expect(result).toHaveTextContent('YetkazishBepul');
    expect(result).toHaveTextContent(/100\s000\sso‘m/);
    expect(result).toHaveTextContent('Bu hududda yo‘q');
    expect(result).toHaveTextContent('09:00–21:00, hozir ishlayapti');

    fireEvent.click(within(result).getByRole('button', { name: 'Chilonzor tumanini tanlash' }));
    expect(onChoose).toHaveBeenCalledWith('chilonzor');
  });

  it('served, Russian: fee and free-delivery threshold in so‘m', async () => {
    fake.search.mockResolvedValue([toponym('Юнусабадский район', 'Ташкент, Узбекистан')]);
    await ready({ locale: 'ru' });
    const result = await confirmPoint('Доставить сюда');
    expect(within(result).getByRole('heading')).toHaveTextContent(
      'Доставляем в этот район: Юнусабад',
    );
    expect(result).toHaveTextContent(/Доставка15\s000\sсум/);
    expect(result).toHaveTextContent(/от 300\s000\sсум/);
    expect(result).toHaveTextContent('Демо');
  });

  it('a real (non-demo) zone shows no demo hint', async () => {
    fake.search.mockResolvedValue([toponym('Yunusobod tumani', 'Toshkent')]);
    await ready({ zones: [zone({ slug: 'markaziy', name_uz: 'Markaziy' })] });
    const result = await confirmPoint();
    expect(within(result).queryByTestId('demo-badge')).toBeNull();
    expect(within(result).queryByTestId('demo-note')).toBeNull();
  });

  it('not served: says so by name and offers served neighbours', async () => {
    fake.search.mockResolvedValue([toponym('Yakkasaroy tumani', 'Toshkent')]);
    const { onChoose } = await ready();
    const result = await confirmPoint();
    expect(result).toHaveAttribute('data-status', 'not-served');
    expect(within(result).getByRole('heading')).toHaveTextContent(
      'Yakkasaroy tumaniga hozircha yetkazmaymiz',
    );
    expect(result).toHaveTextContent('Yaqin tumanlardan biriga yetkazib beramiz:');
    fireEvent.click(within(result).getByRole('button', { name: 'Mirobod' }));
    expect(onChoose).toHaveBeenCalledWith('mirobod');
  });

  it('outside Tashkent: honest, with a way to move the pin or use the list', async () => {
    fake.search.mockResolvedValue([toponym('Samarqand', 'O‘zbekiston')]);
    await ready();
    fake.maps[0]?.update({ location: { center: [66.96, 39.65], zoom: 12 } });
    const result = await confirmPoint();
    expect(result).toHaveAttribute('data-status', 'outside');
    expect(result).toHaveTextContent('Toshkent shahridan tashqarida');
    fireEvent.click(within(result).getByRole('button', { name: 'Nuqtani o‘zgartirish' }));
    expect(screen.queryByTestId('map-result')).toBeNull();
    expect(screen.getByTestId('map-canvas')).toHaveFocus();
  });

  it('lookup unavailable (403, quota, offline): never claims delivery, sends to the list', async () => {
    fake.search.mockRejectedValue(new Error('403'));
    const { onClose, onChoose } = await ready();
    const result = await confirmPoint();
    expect(result).toHaveAttribute('data-status', 'lookup-failed');
    expect(result).toHaveTextContent('Tumanni avtomatik tekshirib bo‘lmadi');
    expect(result.textContent).not.toMatch(/yetkazib beramiz/);
    fireEvent.click(within(result).getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('an SDK without geosearch falls back the same way', async () => {
    fake = makeYMaps({ withoutSearch: true });
    await ready();
    const result = await confirmPoint();
    expect(result).toHaveAttribute('data-status', 'lookup-failed');
  });

  it('a district the lookup cannot name: asks for the list', async () => {
    fake.search.mockResolvedValue([toponym('Amir Temur xiyoboni', 'Toshkent')]);
    await ready();
    const result = await confirmPoint();
    expect(result).toHaveAttribute('data-status', 'unknown');
  });

  it('moving the map while checking discards the stale answer', async () => {
    let answer: (value: ReturnType<typeof toponym>[]) => void = () => undefined;
    fake.search.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    expect(screen.getByTestId('map-confirm')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('map-confirm')).toHaveTextContent('Tuman aniqlanmoqda…');
    act(() => fake.listeners[0]?.onActionStart?.());
    await act(async () => answer([toponym('Chilonzor tumani', 'Toshkent')]));
    expect(screen.queryByTestId('map-result')).toBeNull();
    expect(screen.getByTestId('map-confirm')).toHaveTextContent('Shu yerga yetkazish');
  });

  it('dragging after a result returns to picking', async () => {
    fake.search.mockResolvedValue([toponym('Chilonzor tumani', 'Toshkent')]);
    await ready();
    await confirmPoint();
    act(() => fake.listeners[0]?.onActionStart?.());
    expect(screen.queryByTestId('map-result')).toBeNull();
  });

  it('privacy: the point is not stored, logged, sent to our API or put in the URL', async () => {
    fake.search.mockResolvedValue([toponym('Chilonzor tumani', 'Toshkent')]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const href = window.location.href;
    await ready();
    await confirmPoint();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.cookie).not.toMatch(/69\.|41\./);
    expect(document.body.innerHTML).not.toMatch(/69\.2797|41\.3111/);
  });
});

describe('AddressPicker: keyboard', () => {
  it('focuses "Back" on open, traps Tab, and closes on Escape', async () => {
    autoloadYandexScript('load', fake.api);
    const { onClose } = renderPicker();
    const back = screen.getByRole('button', { name: 'Orqaga' });
    expect(back).toHaveFocus();
    await screen.findByTestId('map-canvas');

    const last = screen.getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pans with the arrow keys and zooms with +/-, instantly (no animation)', async () => {
    autoloadYandexScript('load', fake.api);
    renderPicker();
    const canvas = await screen.findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    expect(canvas).toHaveAccessibleName('Xarita. Strelka tugmalari bilan suring.');
    const map = fake.maps[0];

    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    const right = map?.update.mock.lastCall?.[0] as {
      location: { center: [number, number]; zoom: number; duration: number };
    };
    expect(right.location.duration).toBe(0);
    expect(right.location.center[0]).toBeGreaterThan(TASHKENT_CENTER[0]);
    expect(right.location.center[1]).toBe(TASHKENT_CENTER[1]);

    fireEvent.keyDown(canvas, { key: 'ArrowUp' });
    const up = map?.update.mock.lastCall?.[0] as { location: { center: [number, number] } };
    expect(up.location.center[1]).toBeGreaterThan(TASHKENT_CENTER[1]);

    fireEvent.keyDown(canvas, { key: '+' });
    expect(map?.zoom).toBe(13);
    fireEvent.keyDown(canvas, { key: '-' });
    expect(map?.zoom).toBe(12);
  });
});

describe('AddressPicker: "My location"', () => {
  function mockGeolocation(result: 'denied' | 'unavailable' | 'ok') {
    const getCurrentPosition = vi.fn(
      (success: PositionCallback, failure?: PositionErrorCallback | null) => {
        if (result === 'ok') {
          success({ coords: { latitude: 41.3, longitude: 69.25 } } as GeolocationPosition);
          return;
        }
        failure?.({
          code: result === 'denied' ? 1 : 2,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
          message: '',
        } as GeolocationPositionError);
      },
    );
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    });
    return getCurrentPosition;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'geolocation');
  });

  it('never asks for location on its own; when pressed it only moves the map', async () => {
    const locate = mockGeolocation('ok');
    await ready();
    expect(locate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    expect(locate).toHaveBeenCalledTimes(1);
    expect(fake.maps[0]?.update).toHaveBeenLastCalledWith({
      location: { center: [69.25, 41.3], zoom: 16, duration: 200 },
    });
    // Used for delivery only after "Deliver here".
    expect(fake.search).not.toHaveBeenCalled();
    await confirmPoint();
    expect(fake.search.mock.calls[0]?.[0].text).toBe('69.250000,41.300000');
  });

  it('explains a denied permission in its own UI; the pin still works', async () => {
    mockGeolocation('denied');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    await waitFor(() =>
      expect(screen.getByTestId('map-locate-status')).toHaveTextContent(
        'Joylashuvga ruxsat berilmagan.',
      ),
    );
    expect(screen.getByTestId('map-confirm')).toBeEnabled();
  });

  it('explains an unavailable position', async () => {
    mockGeolocation('unavailable');
    await ready({ locale: 'ru' });
    fireEvent.click(screen.getByRole('button', { name: 'Моё местоположение' }));
    expect(screen.getByTestId('map-locate-status')).toHaveTextContent(
      'Не удалось определить местоположение.',
    );
  });
});

describe('AddressPicker: inside Telegram', () => {
  it('drives the native BackButton and hides the MainButton while open', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { onClose } = await ready();

    expect(webApp.BackButton.show).toHaveBeenCalled();
    const handler = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    handler?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
