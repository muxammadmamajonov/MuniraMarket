import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import type { Address } from '@/lib/address/address';
import type { GeocoderResult } from '@/lib/maps/reverse-geocode';
import {
  autoloadYandexScript,
  houseResult,
  makeYMaps,
  mockGeocoderFetch,
  type FakeYMaps,
  type GeocoderAnswer,
} from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import type { LngLat } from '@/lib/maps/yandex-types';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { AddressPicker, GEOCODE_DEBOUNCE_MS, TASHKENT_CENTER } from './address-picker';

// Placeholder shape only; jsdom never fetches the script and the SDK is a fake.
const KEY = '00000000-0000-4000-8000-000000000000';
const GEOCODER_KEY = '11111111-1111-4111-8111-111111111111';

const SAVED: Address = {
  lat: 41.2995,
  lon: 69.2401,
  street: 'Bunyodkor ko‘chasi',
  house: '7',
  apartment: '12',
  entrance: '',
  floor: '3',
  landmark: '',
};

function renderPicker({
  apiKey = KEY,
  geocoderApiKey = apiKey,
  locale = 'uz',
  initial = null,
  onClose = vi.fn(),
  onSave = vi.fn(),
}: {
  apiKey?: string | null;
  geocoderApiKey?: string | null;
  locale?: 'uz' | 'ru';
  initial?: Address | null;
  onClose?: () => void;
  onSave?: Mock<(address: Address) => void>;
} = {}) {
  const view = render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={apiKey} geocoderApiKey={geocoderApiKey}>
          <button>trigger</button>
          <AddressPicker open onClose={onClose} initial={initial} onSave={onSave} />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
  return { onClose, onSave, unmount: view.unmount };
}

let fake: FakeYMaps;
let geocoder: ReturnType<typeof mockGeocoderFetch>;

beforeEach(() => {
  fake = makeYMaps();
  geocoder = mockGeocoderFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetYandexMapsLoader();
  delete window.ymaps3;
  uninstallWebApp();
  document.body.style.overflow = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** Renders the picker, waits for the (fake) map, then switches to fake timers for the debounce. */
async function ready(options: Parameters<typeof renderPicker>[0] = {}) {
  autoloadYandexScript('load', fake.api);
  const result = renderPicker(options);
  await screen.findByTestId('map-canvas');
  await waitFor(() => expect(fake.maps).toHaveLength(1));
  vi.useFakeTimers();
  return result;
}

/** A drag that ends with the map centred on `center`. */
function drag(center: LngLat) {
  act(() => {
    fake.listeners[0]?.onActionStart?.();
    fake.maps[0]?.update({ location: { center, zoom: 16 } });
    fake.listeners[0]?.onActionEnd?.();
  });
}

/** Lets the map rest long enough for the lookup to start and settle. */
async function settle(ms = GEOCODE_DEBOUNCE_MS) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

function input(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name: new RegExp(`^${name}`) });
}

function deferred() {
  let resolve: (value: GeocoderResult | null) => void = () => undefined;
  const promise = new Promise<GeocoderResult | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AddressPicker: opens straight to the map and the form', () => {
  it('shows the map, the centre pin and the address form in one dialog', async () => {
    await ready();
    const dialog = screen.getByRole('dialog', { name: 'Yetkazish manzili' });
    expect(within(dialog).getByTestId('map-canvas')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('img', { name: 'Yetkazish nuqtasi xarita markazida' }),
    ).toBeVisible();
    const form = within(dialog).getByTestId('address-form');
    for (const label of ['Ko‘cha', 'Uy', 'Xonadon', 'Podyezd', 'Qavat', 'Mo‘ljal yoki izoh']) {
      expect(within(form).getByRole('textbox', { name: new RegExp(`^${label}`) })).toHaveValue('');
    }
    expect(within(form).getByRole('button', { name: 'Shu yerga yetkazish' })).toBeEnabled();
    expect(screen.getByTestId('map-status')).toHaveTextContent(
      'Xaritani suring: markazdagi belgi yetkazish nuqtasi.',
    );
  });

  it('starts centred on Tashkent with the Yandex layers and a gesture listener', async () => {
    await ready();
    expect(fake.maps[0]?.props.location).toEqual({ center: TASHKENT_CENTER, zoom: 12 });
    expect(fake.maps[0]?.children).toHaveLength(3);
    expect(fake.listeners).toHaveLength(1);
  });

  it.each(['uz', 'ru'] as const)(
    'says nothing about areas, zones, prices, fees or free delivery (%s)',
    async (locale) => {
      geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '15'));
      await ready({ locale });
      drag([69.25, 41.3]);
      await settle();
      expect(screen.getByRole('dialog').textContent).not.toMatch(
        /hudud|zona|район|зона|so‘m|сум|bepul|бесплат|narx|цена|стоимост|minimal|минимал/i,
      );
    },
  );

  it('cleans the map up when it closes', async () => {
    const { unmount } = await ready();
    const map = fake.maps[0];
    unmount();
    expect(map?.destroy).toHaveBeenCalled();
  });
});

describe('AddressPicker: without a key, loading and errors', () => {
  it('shows its own fallback and loads nothing without a key', () => {
    const append = vi.spyOn(document.head, 'append');
    const { onClose } = renderPicker({ apiKey: null });
    const dialog = screen.getByRole('dialog', { name: 'Yetkazish manzili' });
    expect(within(dialog).getByTestId('map-unavailable')).toHaveTextContent(
      'Xarita bu yerda ishlamaydi',
    );
    expect(within(dialog).queryByTestId('map-confirm')).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(document.querySelector('script[data-mm-yandex-maps]')).toBeNull();
    const unavailable = within(dialog).getByTestId('map-unavailable');
    fireEvent.click(within(unavailable).getByRole('button', { name: 'Orqaga' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is localized', () => {
    renderPicker({ apiKey: null, locale: 'ru' });
    expect(screen.getByRole('dialog', { name: 'Адрес доставки' })).toHaveTextContent(
      'Карта здесь не работает',
    );
  });

  it('shows a loading state; the form is there but "Deliver here" waits for the map', () => {
    autoloadYandexScript('hang');
    renderPicker();
    expect(screen.getByTestId('map-loading')).toHaveTextContent('Xarita yuklanmoqda…');
    expect(screen.getByTestId('address-form')).toBeInTheDocument();
    expect(screen.getByTestId('map-confirm')).toBeDisabled();
  });

  it('shows an error with a working retry', async () => {
    const failing = autoloadYandexScript('error');
    renderPicker();
    const error = await screen.findByTestId('map-error');
    expect(error).toHaveTextContent('Xaritani yuklab bo‘lmadi');
    expect(screen.queryByTestId('address-form')).toBeNull();

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

describe('AddressPicker: the address is looked up when the map stops', () => {
  it('fills street and house from the Geocoder once the map has rested', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '15'));
    await ready({ geocoderApiKey: GEOCODER_KEY });
    drag([69.2401234567, 41.3112345678]);

    // Not on every frame: only after the quiet period.
    await settle(GEOCODE_DEBOUNCE_MS - 1);
    expect(geocoder.answer).not.toHaveBeenCalled();
    await settle(1);

    expect(geocoder.answer).toHaveBeenCalledTimes(1);
    expect(geocoder.answer).toHaveBeenCalledWith('69.240123,41.311235');
    const [request] = geocoder.fetch.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.searchParams.get('apikey')).toBe(GEOCODER_KEY);
    expect(url.searchParams.get('kind')).toBe('house');

    expect(input('Ko‘cha')).toHaveValue('Amir Temur ko‘chasi');
    expect(input('Uy')).toHaveValue('15');
    expect(screen.getByTestId('map-status')).toHaveAttribute('data-lookup', 'idle');
  });

  it('a burst of moves makes one lookup, for where the map finally stopped', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Navoiy ko‘chasi', '3'));
    await ready();
    drag([69.2, 41.3]);
    await settle(GEOCODE_DEBOUNCE_MS / 2);
    drag([69.21, 41.31]);
    await settle();
    expect(geocoder.answer).toHaveBeenCalledTimes(1);
    expect(geocoder.answer).toHaveBeenCalledWith('69.210000,41.310000');
  });

  it('ignores a stale answer when the map moved again meanwhile', async () => {
    const first = deferred();
    const second = deferred();
    geocoder.answer
      .mockImplementationOnce((() => first.promise) as GeocoderAnswer)
      .mockImplementationOnce((() => second.promise) as GeocoderAnswer);
    await ready();

    drag([69.2, 41.3]);
    await settle();
    expect(screen.getByTestId('map-status')).toHaveTextContent('Manzil aniqlanmoqda…');

    // The customer drags on before the first answer arrives.
    act(() => fake.listeners[0]?.onActionStart?.());
    await act(async () => first.resolve(houseResult('Eski ko‘cha', '1')));
    expect(input('Ko‘cha')).toHaveValue('');
    expect(input('Uy')).toHaveValue('');

    act(() => {
      fake.maps[0]?.update({ location: { center: [69.3, 41.35], zoom: 16 } });
      fake.listeners[0]?.onActionEnd?.();
    });
    await settle();
    await act(async () => second.resolve(houseResult('Yangi ko‘cha', '2')));
    expect(input('Ko‘cha')).toHaveValue('Yangi ko‘cha');
    expect(input('Uy')).toHaveValue('2');
  });

  it('keeps a typed street when the lookup finds only a house', async () => {
    geocoder.answer.mockResolvedValue({ name: 'x', components: [{ kind: 'house', name: '9' }] });
    await ready();
    fireEvent.change(input('Ko‘cha'), { target: { value: 'Mening ko‘cham' } });
    drag([69.2, 41.3]);
    await settle();
    expect(input('Ko‘cha')).toHaveValue('Mening ko‘cham');
    expect(input('Uy')).toHaveValue('9');
  });

  it('asks the customer to type the address when the lookup fails; the pin still counts', async () => {
    geocoder.answer.mockResolvedValue(new Response('', { status: 403 }));
    const { onSave } = await ready();
    drag([69.2, 41.3]);
    await settle();
    expect(screen.getByTestId('map-status')).toHaveTextContent(
      'Manzilni aniqlab bo‘lmadi. Ko‘cha va uyni yozing.',
    );
    fireEvent.change(input('Ko‘cha'), { target: { value: 'Qo‘lda ko‘cha' } });
    fireEvent.change(input('Uy'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 41.3, lon: 69.2, street: 'Qo‘lda ko‘cha', house: '4' }),
    );
  });

  it('without a Geocoder key it looks nothing up and says to type the address', async () => {
    autoloadYandexScript('load', fake.api);
    renderPicker({ geocoderApiKey: null });
    await screen.findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    vi.useFakeTimers();
    drag([69.2, 41.3]);
    await settle();
    expect(geocoder.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('map-status')).toHaveAttribute('data-lookup', 'failed');
  });
});

describe('AddressPicker: "Deliver here"', () => {
  it('before the map was moved, asks to place the pin and saves nothing', async () => {
    const { onSave } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    expect(screen.getByTestId('map-place-pin')).toHaveTextContent(
      'Avval xaritani surib, nuqtani belgilang.',
    );
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('map-place-pin'));
    expect(screen.getByTestId('map-canvas')).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();

    // Moving the map clears the message.
    drag([69.2, 41.3]);
    expect(screen.queryByTestId('map-place-pin')).toBeNull();
  });

  it('shows field errors (an empty house) and focuses the first one', async () => {
    geocoder.answer.mockResolvedValue({
      name: 'Bunyodkor ko‘chasi',
      components: [{ kind: 'street', name: 'Bunyodkor ko‘chasi' }],
    });
    const { onSave } = await ready();
    drag([69.2, 41.3]);
    await settle();
    expect(input('Ko‘cha')).toHaveValue('Bunyodkor ko‘chasi');
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(input('Uy')).toHaveAccessibleDescription(/To‘ldirish shart/);
    expect(input('Uy')).toHaveFocus();
    expect(input('Ko‘cha')).not.toHaveAccessibleDescription(/To‘ldirish shart/);

    // Typing clears that field's error.
    fireEvent.change(input('Uy'), { target: { value: '15' } });
    expect(input('Uy')).not.toHaveAccessibleDescription(/To‘ldirish shart/);
  });

  it('flags a too-short street and an empty one (Russian copy)', async () => {
    const { onSave } = await ready({ locale: 'ru' });
    drag([69.2, 41.3]);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Доставить сюда' }));
    expect(input('Улица')).toHaveFocus();
    fireEvent.change(input('Улица'), { target: { value: 'a' } });
    fireEvent.change(input('Дом'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Доставить сюда' }));
    expect(input('Улица')).toHaveAccessibleDescription(/2/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the map centre rounded to 6 decimals and the trimmed text', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '15'));
    const { onSave } = await ready();
    drag([69.24056251, 41.31108149]);
    await settle();
    fireEvent.change(input('Xonadon'), { target: { value: ' 4 ' } });
    fireEvent.change(input('Podyezd'), { target: { value: '   ' } });
    fireEvent.change(input('Mo‘ljal yoki izoh'), { target: { value: '  Maktab yonida ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      lat: 41.311081,
      lon: 69.240563,
      street: 'Amir Temur ko‘chasi',
      house: '15',
      apartment: '4',
      entrance: '',
      floor: '',
      landmark: 'Maktab yonida',
    });
  });
});

describe('AddressPicker: editing a saved address', () => {
  it('starts at its point with its text and does not look anything up until moved', async () => {
    const { onSave } = await ready({ initial: SAVED });
    expect(fake.maps[0]?.props.location).toEqual({ center: [69.2401, 41.2995], zoom: 16 });
    expect(input('Ko‘cha')).toHaveValue('Bunyodkor ko‘chasi');
    expect(input('Uy')).toHaveValue('7');
    expect(input('Xonadon')).toHaveValue('12');
    expect(input('Qavat')).toHaveValue('3');

    await settle(GEOCODE_DEBOUNCE_MS * 5);
    expect(geocoder.fetch).not.toHaveBeenCalled();

    // The saved point counts as placed: "Deliver here" works right away.
    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    expect(screen.queryByTestId('map-place-pin')).toBeNull();
    expect(onSave).toHaveBeenCalledWith(SAVED);
  });

  it('moving it looks the new point up and replaces street and house', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Navoiy ko‘chasi', '30'));
    await ready({ initial: SAVED });
    drag([69.25, 41.32]);
    await settle();
    expect(geocoder.answer).toHaveBeenCalledTimes(1);
    expect(input('Ko‘cha')).toHaveValue('Navoiy ko‘chasi');
    expect(input('Uy')).toHaveValue('30');
    // What the customer typed for the door stays.
    expect(input('Xonadon')).toHaveValue('12');
  });
});

describe('AddressPicker: keyboard', () => {
  it('focuses "Back" on open, traps Tab, and closes on Escape', async () => {
    autoloadYandexScript('load', fake.api);
    const { onClose } = renderPicker();
    const back = screen.getByRole('button', { name: 'Orqaga' });
    expect(back).toHaveFocus();
    await screen.findByTestId('map-canvas');
    await waitFor(() => expect(screen.getByTestId('map-confirm')).toBeEnabled());

    const last = screen.getByTestId('map-confirm');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pans with the arrow keys and zooms with +/-, instantly; a key move is a move', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '1'));
    await ready();
    const canvas = screen.getByTestId('map-canvas');
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

    await settle();
    expect(geocoder.answer).toHaveBeenCalledTimes(1);
    expect(input('Ko‘cha')).toHaveValue('Amir Temur ko‘chasi');
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

  it('sits in the bottom actions next to "Deliver here"', async () => {
    mockGeolocation('ok');
    await ready();
    const actions = screen.getByTestId('map-actions');
    expect(within(actions).getByRole('button', { name: 'Mening joylashuvim' })).toBe(
      screen.getByTestId('map-locate'),
    );
    expect(within(actions).getByRole('button', { name: 'Shu yerga yetkazish' })).toBe(
      screen.getByTestId('map-confirm'),
    );
  });

  it('is not offered without geolocation', async () => {
    await ready();
    expect(screen.queryByTestId('map-locate')).toBeNull();
  });

  it('never asks for location on its own; when pressed it moves the map and looks it up', async () => {
    const locate = mockGeolocation('ok');
    geocoder.answer.mockResolvedValue(houseResult('Shota Rustaveli ko‘chasi', '21'));
    const { onSave } = await ready();
    expect(locate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    expect(locate).toHaveBeenCalledTimes(1);
    expect(fake.maps[0]?.update).toHaveBeenLastCalledWith({
      location: { center: [69.25, 41.3], zoom: 16, duration: 200 },
    });
    await settle();
    expect(geocoder.answer).toHaveBeenCalledWith('69.250000,41.300000');
    expect(input('Ko‘cha')).toHaveValue('Shota Rustaveli ko‘chasi');

    fireEvent.click(screen.getByRole('button', { name: 'Shu yerga yetkazish' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 41.3, lon: 69.25, house: '21' }),
    );
  });

  it('explains a denied permission in its own UI; the pin still works', async () => {
    mockGeolocation('denied');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Mening joylashuvim' }));
    expect(screen.getByTestId('map-status')).toHaveTextContent(
      'Joylashuvga ruxsat berilmagan. Xaritani qo‘lda suring.',
    );
    expect(screen.getByTestId('map-confirm')).toBeEnabled();
  });

  it('explains an unavailable position', async () => {
    mockGeolocation('unavailable');
    await ready({ locale: 'ru' });
    fireEvent.click(screen.getByRole('button', { name: 'Моё местоположение' }));
    expect(screen.getByTestId('map-status')).toHaveTextContent(
      'Не удалось определить местоположение.',
    );
  });
});

describe('AddressPicker: privacy', () => {
  it('the point goes only to the Geocoder: not stored, logged, or put in the URL', async () => {
    geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '15'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const href = window.location.href;
    await ready();
    drag([69.2797, 41.3111]);
    await settle();
    expect(geocoder.fetch).toHaveBeenCalledOnce();
    expect(String(geocoder.fetch.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/geocode-maps\.yandex\.ru\//,
    );
    expect(setItem).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.body.innerHTML).not.toMatch(/69\.2797|41\.3111/);
  });
});

describe('AddressPicker: inside Telegram', () => {
  it('drives the native BackButton', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { onClose } = await ready();

    expect(webApp.BackButton.show).toHaveBeenCalled();
    const handler = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    handler?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
