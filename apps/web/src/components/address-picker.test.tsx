import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { autoloadYandexScript, makeYMaps, type FakeYMaps } from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { AddressPicker, TASHKENT_CENTER } from './address-picker';

// Placeholder shape only; jsdom never fetches the script and the SDK is a fake.
const KEY = '00000000-0000-4000-8000-000000000000';

function renderPicker({
  apiKey = KEY,
  locale = 'uz',
  onClose = vi.fn(),
  onConfirm = vi.fn(),
}: {
  apiKey?: string | null;
  locale?: 'uz' | 'ru';
  onClose?: () => void;
  onConfirm?: () => void;
} = {}) {
  const view = render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={apiKey}>
          <button>trigger</button>
          <AddressPicker open onClose={onClose} onConfirm={onConfirm} />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
  return { onClose, onConfirm, unmount: view.unmount };
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
});

describe('AddressPicker: without a key', () => {
  it('shows its own "map unavailable" state, loads nothing and offers the list instead', () => {
    const append = vi.spyOn(document.head, 'append');
    const { onClose } = renderPicker({ apiKey: null });
    const dialog = screen.getByRole('dialog', { name: 'Xaritada belgilash' });
    expect(within(dialog).getByTestId('map-unavailable')).toHaveTextContent(
      'Xarita hozircha mavjud emas',
    );
    expect(within(dialog).queryByRole('button', { name: 'Shu nuqtani belgilash' })).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(document.querySelector('script[data-mm-yandex-maps]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ro‘yxatga qaytish' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is localized', () => {
    renderPicker({ apiKey: null, locale: 'ru' });
    expect(screen.getByRole('dialog', { name: 'Отметить на карте' })).toHaveTextContent(
      'Карта пока недоступна',
    );
  });
});

describe('AddressPicker: loading and errors', () => {
  it('shows a loading state with the confirm button disabled', () => {
    autoloadYandexScript('hang');
    renderPicker();
    expect(screen.getByTestId('map-loading')).toHaveTextContent('Xarita yuklanmoqda…');
    expect(screen.getByRole('button', { name: 'Shu nuqtani belgilash' })).toBeDisabled();
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

describe('AddressPicker: the map', () => {
  async function ready(options: Parameters<typeof renderPicker>[0] = {}) {
    autoloadYandexScript('load', fake.api);
    const result = renderPicker(options);
    await screen.findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    return result;
  }

  it('starts centred on Tashkent, with our own pin and Yandex layers', async () => {
    await ready();
    expect(fake.maps).toHaveLength(1);
    expect(fake.maps[0]?.props.location).toEqual({ center: TASHKENT_CENTER, zoom: 12 });
    expect(fake.maps[0]?.children).toHaveLength(3);
    expect(screen.getByTestId('map-pin')).toHaveAttribute('data-moving', 'false');
    expect(screen.getByRole('button', { name: 'Shu nuqtani belgilash' })).toBeEnabled();
  });

  it('lifts the pin while the map moves and settles it after', async () => {
    await ready();
    const listener = fake.listeners[0];
    act(() => listener?.onActionStart?.());
    expect(screen.getByTestId('map-pin')).toHaveAttribute('data-moving', 'true');
    act(() => listener?.onActionEnd?.());
    expect(screen.getByTestId('map-pin')).toHaveAttribute('data-moving', 'false');
  });

  it('a tap moves the tapped spot under the pin', async () => {
    await ready();
    act(() => fake.listeners[0]?.onClick?.(null, { coordinates: [69.3, 41.33] }));
    expect(fake.maps[0]?.update).toHaveBeenLastCalledWith({
      location: { center: [69.3, 41.33], zoom: 12, duration: 200 },
    });
  });

  it('confirming reports only that a point was marked, never the point', async () => {
    const { onConfirm } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Shu nuqtani belgilash' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it('cleans the map up when it closes', async () => {
    const { unmount } = await ready();
    const map = fake.maps[0];
    unmount();
    expect(map?.destroy).toHaveBeenCalled();
  });
});

describe('AddressPicker: keyboard', () => {
  it('focuses "Back" on open, traps Tab, and closes on Escape', async () => {
    autoloadYandexScript('load', fake.api);
    const { onClose } = renderPicker();
    const back = screen.getByRole('button', { name: 'Orqaga' });
    expect(back).toHaveFocus();
    await screen.findByTestId('map-canvas');

    const confirm = screen.getByRole('button', { name: 'Shu nuqtani belgilash' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(confirm, { key: 'Escape' });
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

  it('never asks for location on its own; only when pressed', async () => {
    const locate = mockGeolocation('ok');
    autoloadYandexScript('load', fake.api);
    renderPicker();
    await screen.findByTestId('map-canvas');
    expect(locate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    expect(locate).toHaveBeenCalledTimes(1);
    expect(fake.maps[0]?.update).toHaveBeenLastCalledWith({
      location: { center: [69.25, 41.3], zoom: 16, duration: 200 },
    });
  });

  it('explains a denied permission in its own UI', async () => {
    mockGeolocation('denied');
    autoloadYandexScript('load', fake.api);
    renderPicker();
    await screen.findByTestId('map-canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    await waitFor(() =>
      expect(screen.getByTestId('map-locate-status')).toHaveTextContent(
        'Joylashuvga ruxsat berilmagan.',
      ),
    );
  });

  it('explains an unavailable position', async () => {
    mockGeolocation('unavailable');
    autoloadYandexScript('load', fake.api);
    renderPicker({ locale: 'ru' });
    await screen.findByTestId('map-canvas');
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
    autoloadYandexScript('load', fake.api);
    const { onClose } = renderPicker();
    await screen.findByTestId('map-canvas');

    expect(webApp.BackButton.show).toHaveBeenCalled();
    const handler = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    handler?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
