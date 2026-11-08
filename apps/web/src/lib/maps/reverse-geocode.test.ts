import { afterEach, describe, expect, it, vi } from 'vitest';
import { reverseGeocodeDistrict } from './reverse-geocode';
import { makeYMaps, toponym } from './test-helpers';

// Placeholder shape only; nothing is sent anywhere.
const KEY = '00000000-0000-4000-8000-000000000000';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('reverseGeocodeDistrict', () => {
  it('asks Yandex geosearch for toponyms at "lng,lat" with the configured key', async () => {
    const fake = makeYMaps();
    fake.search.mockResolvedValue([toponym('Yunusobod tumani', 'Toshkent, O‘zbekiston')]);
    const result = await reverseGeocodeDistrict(fake.api, [69.2851234567, 41.3612345678], {
      apiKey: KEY,
    });
    expect(result).toEqual({ kind: 'district', code: 'yunusobod' });
    expect(fake.setApikeys).toHaveBeenCalledWith({ search: KEY });
    expect(fake.search).toHaveBeenCalledWith({
      text: '69.285123,41.361235',
      type: ['toponyms'],
      limit: 10,
    });
  });

  it.each([
    ['403 / key without the Search API', () => Promise.reject(new Error('403 Forbidden'))],
    ['quota', () => Promise.reject(new Error('429'))],
    ['malformed', () => Promise.resolve('nope' as never)],
  ])('returns null (never a guess) on failure: %s', async (_name, impl) => {
    const fake = makeYMaps();
    fake.search.mockImplementation(impl);
    const error = vi.spyOn(console, 'error');
    await expect(
      reverseGeocodeDistrict(fake.api, [69.28, 41.31], { apiKey: KEY }),
    ).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null when the SDK has no geosearch', async () => {
    const fake = makeYMaps({ withoutSearch: true });
    await expect(
      reverseGeocodeDistrict(fake.api, [69.28, 41.31], { apiKey: KEY }),
    ).resolves.toBeNull();
  });

  it('returns null offline without asking', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fake = makeYMaps();
    await expect(
      reverseGeocodeDistrict(fake.api, [69.28, 41.31], { apiKey: KEY }),
    ).resolves.toBeNull();
    expect(fake.search).not.toHaveBeenCalled();
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    const fake = makeYMaps();
    fake.search.mockReturnValue(new Promise(() => undefined));
    const pending = reverseGeocodeDistrict(fake.api, [69.28, 41.31], {
      apiKey: KEY,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toBeNull();
  });
});
