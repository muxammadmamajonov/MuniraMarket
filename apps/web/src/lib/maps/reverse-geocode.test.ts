import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressFromResult, reverseGeocodeAddress } from './reverse-geocode';
import { geocoderBody, houseComponents, houseResult } from './test-helpers';

// Placeholder shape only; no real key or location is used by this test.
const KEY = '00000000-0000-4000-8000-000000000000';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('reverseGeocodeAddress', () => {
  it('asks the Geocoder HTTP API for the nearest house, in Russian, with the configured key', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok(geocoderBody(houseResult('улица Бунёдкор', '15'))));

    await expect(
      reverseGeocodeAddress([69.2851234567, 41.3612345678], { apiKey: KEY }),
    ).resolves.toEqual({ street: 'улица Бунёдкор', house: '15' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [request, init] = fetchSpy.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin).toBe('https://geocode-maps.yandex.ru');
    expect(url.pathname).toBe('/v1');
    expect(url.searchParams.get('apikey')).toBe(KEY);
    // `lng,lat` with six decimals (~10 cm).
    expect(url.searchParams.get('geocode')).toBe('69.285123,41.361235');
    expect(url.searchParams.get('sco')).toBe('longlat');
    expect(url.searchParams.get('kind')).toBe('house');
    expect(url.searchParams.get('results')).toBe('1');
    expect(url.searchParams.get('lang')).toBe('ru_RU');
    expect(url.searchParams.get('format')).toBe('json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the result name, minus the house number, when there is no street (a kvartal)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok(
        geocoderBody({
          name: '9-й квартал, 5',
          components: [
            { kind: 'country', name: 'Узбекистан' },
            { kind: 'locality', name: 'Ташкент' },
            { kind: 'house', name: '5' },
          ],
        }),
      ),
    );
    await expect(reverseGeocodeAddress([69.2, 41.28], { apiKey: KEY })).resolves.toEqual({
      street: '9-й квартал',
      house: '5',
    });
  });

  it.each([
    ['403 / bad or inactive key', () => new Response('', { status: 403 })],
    ['quota', () => new Response('', { status: 429 })],
    ['server error', () => new Response('', { status: 500 })],
    ['malformed response', () => ok({ nope: true })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['nothing found', () => ok(geocoderBody(null))],
    ['a result without components', () => ok(geocoderBody({ name: 'Ташкент', components: [] }))],
  ])('returns null (never a guess) on failure: %s', async (_name, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const error = vi.spyOn(console, 'error');
    await expect(reverseGeocodeAddress([69.28, 41.31], { apiKey: KEY })).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null when the request itself fails (CSP block, network)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(reverseGeocodeAddress([69.28, 41.31], { apiKey: KEY })).resolves.toBeNull();
  });

  it('returns null offline without making a request', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(reverseGeocodeAddress([69.28, 41.31], { apiKey: KEY })).resolves.toBeNull();
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
    const pending = reverseGeocodeAddress([69.28, 41.31], { apiKey: KEY, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('addressFromResult', () => {
  it('takes the street and house components, trimmed', () => {
    expect(
      addressFromResult({
        name: 'улица Амира Темура, 15',
        components: houseComponents(' улица Амира Темура ', ' 15 '),
      }),
    ).toEqual({ street: 'улица Амира Темура', house: '15' });
  });

  it('prefers the most specific (last) component of a kind', () => {
    expect(
      addressFromResult({
        name: 'x',
        components: [
          { kind: 'street', name: 'проспект Шота Руставели' },
          { kind: 'street', name: '1-й проезд Шота Руставели' },
          { kind: 'house', name: '7А' },
        ],
      }),
    ).toEqual({ street: '1-й проезд Шота Руставели', house: '7А' });
  });

  it('without a street, uses the name minus its trailing ", <house>"', () => {
    expect(
      addressFromResult({
        name: ' массив Юнусабад-4, 12 ',
        components: [{ kind: 'house', name: '12' }],
      }),
    ).toEqual({ street: 'массив Юнусабад-4', house: '12' });
  });

  it('keeps the house alone when the name does not end with it', () => {
    expect(
      addressFromResult({ name: 'Ташкент', components: [{ kind: 'house', name: '12' }] }),
    ).toEqual({ street: '', house: '12' });
  });

  it('keeps a street without a house (the customer types the number)', () => {
    expect(
      addressFromResult({
        name: 'улица Бунёдкор',
        components: [{ kind: 'street', name: 'улица Бунёдкор' }],
      }),
    ).toEqual({ street: 'улица Бунёдкор', house: '' });
  });

  it('is null when neither a street nor a house is known', () => {
    expect(
      addressFromResult({
        name: 'Ташкент',
        components: [
          { kind: 'country', name: 'Узбекистан' },
          { kind: 'locality', name: 'Ташкент' },
        ],
      }),
    ).toBeNull();
  });
});
