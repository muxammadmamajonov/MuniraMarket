import { afterEach, describe, expect, it, vi } from 'vitest';
import { reverseGeocodeDistrict } from './reverse-geocode';

// Placeholder shape only; no real key or location is used by this test.
const KEY = '00000000-0000-4000-8000-000000000000';

function geocoderResponse(name: string, description: string) {
  return {
    response: {
      GeoObjectCollection: {
        featureMember: [{ GeoObject: { name, description } }],
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('reverseGeocodeDistrict', () => {
  it('uses the Geocoder HTTP API with a reverse district query and the configured key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(geocoderResponse('Юнусабадский район', 'Ташкент')), {
        status: 200,
      }),
    );

    await expect(
      reverseGeocodeDistrict([69.2851234567, 41.3612345678], { apiKey: KEY }),
    ).resolves.toEqual({
      kind: 'district',
      code: 'yunusobod',
    });

    const [request] = fetchSpy.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin).toBe('https://geocode-maps.yandex.ru');
    expect(url.pathname).toBe('/v1');
    expect(url.searchParams.get('apikey')).toBe(KEY);
    expect(url.searchParams.get('geocode')).toBe('69.285123,41.361235');
    expect(url.searchParams.get('sco')).toBe('longlat');
    expect(url.searchParams.get('kind')).toBe('district');
    expect(url.searchParams.get('lang')).toBe('ru_RU');
  });

  it.each([
    ['403 / bad or inactive key', new Response('', { status: 403 })],
    ['quota', new Response('', { status: 429 })],
    ['malformed response', new Response(JSON.stringify({ nope: true }), { status: 200 })],
  ])('returns null (never a guess) on failure: %s', async (_name, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const error = vi.spyOn(console, 'error');
    await expect(reverseGeocodeDistrict([69.28, 41.31], { apiKey: KEY })).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null offline without making a request', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(reverseGeocodeDistrict([69.28, 41.31], { apiKey: KEY })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const pending = reverseGeocodeDistrict([69.28, 41.31], { apiKey: KEY, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
