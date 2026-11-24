import { afterEach, describe, expect, it, vi } from 'vitest';
import { readYandexMapsGeocoderApiKey, readYandexMapsJavaScriptApiKey } from './config';
import { autoloadYandexScript, makeYMaps } from './test-helpers';
import {
  MapsLoadError,
  loadYandexMaps,
  resetYandexMapsLoader,
  yandexMapsScriptUrl,
} from './yandex-loader';

// Placeholders only: real-looking key shapes, never sent to Yandex in tests.
const KEY = '00000000-0000-4000-8000-000000000000';
const COMPACT_KEY = 'test_yandex_key_000000==';

function scripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script[data-mm-yandex-maps]'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetYandexMapsLoader();
  delete window.ymaps3;
});

describe('Yandex key configuration', () => {
  it('reads the JavaScript and Geocoder keys independently, rejecting malformed values', () => {
    expect(readYandexMapsJavaScriptApiKey({})).toBeNull();
    expect(readYandexMapsGeocoderApiKey({ YANDEX_MAPS_GEOCODER_API_KEY: '' })).toBeNull();
    expect(
      readYandexMapsJavaScriptApiKey({ YANDEX_MAPS_JAVASCRIPT_API_KEY: 'not-a-key' }),
    ).toBeNull();
    expect(
      readYandexMapsGeocoderApiKey({ YANDEX_MAPS_GEOCODER_API_KEY: `${KEY}"><script>` }),
    ).toBeNull();
    expect(readYandexMapsJavaScriptApiKey({ YANDEX_MAPS_JAVASCRIPT_API_KEY: ` ${KEY} ` })).toBe(
      KEY,
    );
    expect(readYandexMapsGeocoderApiKey({ YANDEX_MAPS_GEOCODER_API_KEY: COMPACT_KEY })).toBe(
      COMPACT_KEY,
    );
  });
});

describe('yandexMapsScriptUrl', () => {
  it('points at the official v3 API host with the key and the UI language', () => {
    const uz = new URL(yandexMapsScriptUrl(KEY, 'uz'));
    expect(uz.origin).toBe('https://api-maps.yandex.ru');
    expect(uz.pathname).toBe('/v3/');
    expect(uz.searchParams.get('apikey')).toBe(KEY);
    expect(uz.searchParams.get('lang')).toBe('ru_RU');
    expect(new URL(yandexMapsScriptUrl(KEY, 'ru')).searchParams.get('lang')).toBe('ru_RU');
  });
});

describe('loadYandexMaps', () => {
  it('injects nothing until called (the map is lazy)', () => {
    expect(scripts()).toHaveLength(0);
  });

  it('loads once, shares the promise between callers and resolves with ymaps3 when ready', async () => {
    const { api } = makeYMaps();
    autoloadYandexScript('load', api);
    const first = loadYandexMaps({ apiKey: KEY, locale: 'uz' });
    const second = loadYandexMaps({ apiKey: KEY, locale: 'uz' });
    expect(second).toBe(first);
    expect(scripts()).toHaveLength(1);
    await expect(first).resolves.toBe(api);
  });

  it('on a script error, removes the tag and lets a retry start over', async () => {
    const spy = autoloadYandexScript('error');
    await expect(loadYandexMaps({ apiKey: KEY, locale: 'ru' })).rejects.toMatchObject({
      kind: 'script',
    });
    expect(scripts()).toHaveLength(0);

    spy.mockRestore();
    const { api } = makeYMaps();
    autoloadYandexScript('load', api);
    await expect(loadYandexMaps({ apiKey: KEY, locale: 'ru' })).resolves.toBe(api);
  });

  it('fails as "script" when the tag loads but defines no ymaps3', async () => {
    autoloadYandexScript('load', undefined);
    const error = await loadYandexMaps({ apiKey: KEY, locale: 'uz' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MapsLoadError);
    expect((error as MapsLoadError).kind).toBe('script');
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    autoloadYandexScript('hang');
    const pending = loadYandexMaps({ apiKey: KEY, locale: 'uz', timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(scripts()).toHaveLength(0);
  });

  it('does not even try while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(loadYandexMaps({ apiKey: KEY, locale: 'uz' })).rejects.toMatchObject({
      kind: 'offline',
    });
    expect(scripts()).toHaveLength(0);
  });
});
