import { describe, expect, it } from 'vitest';
import { yandexGoCourierUrl } from './index';

describe('yandexGoCourierUrl', () => {
  it('builds the exact courier link for a Tashkent point', () => {
    expect(yandexGoCourierUrl({ lat: 41.311081, lon: 69.240562 })).toBe(
      'https://3.redirect.appmetrica.yandex.com/route?end-lat=41.311081&end-lon=69.240562&tariffClass=courier&level=courier&ref=muniramarket&appmetrica_tracking_id=1178268795219780156&lang=uz',
    );
  });

  it('formats coordinates with exactly 6 decimals', () => {
    const url = new URL(yandexGoCourierUrl({ lat: 41.3110814999, lon: 69.24 }) ?? '');
    expect(url.searchParams.get('end-lat')).toBe('41.311081');
    expect(url.searchParams.get('end-lon')).toBe('69.240000');
    const whole = new URL(yandexGoCourierUrl({ lat: 41, lon: 69 }) ?? '');
    expect(whole.searchParams.get('end-lat')).toBe('41.000000');
    expect(whole.searchParams.get('end-lon')).toBe('69.000000');
  });

  it('accepts negative and boundary coordinates', () => {
    const southWest = new URL(yandexGoCourierUrl({ lat: -33.868819, lon: -151.209295 }) ?? '');
    expect(southWest.searchParams.get('end-lat')).toBe('-33.868819');
    expect(southWest.searchParams.get('end-lon')).toBe('-151.209295');
    const edges = new URL(yandexGoCourierUrl({ lat: 90, lon: -180 }) ?? '');
    expect(edges.searchParams.get('end-lat')).toBe('90.000000');
    expect(edges.searchParams.get('end-lon')).toBe('-180.000000');
    expect(yandexGoCourierUrl({ lat: -90, lon: 180 })).not.toBeNull();
    expect(yandexGoCourierUrl({ lat: 0, lon: 0 })).toContain('end-lat=0.000000&end-lon=0.000000');
  });

  it('returns null for non-finite or out-of-range coordinates', () => {
    for (const point of [
      { lat: Number.NaN, lon: 69.24 },
      { lat: 41.31, lon: Number.NaN },
      { lat: Number.POSITIVE_INFINITY, lon: 69.24 },
      { lat: 41.31, lon: Number.NEGATIVE_INFINITY },
      { lat: 90.000001, lon: 69.24 },
      { lat: -90.5, lon: 69.24 },
      { lat: 41.31, lon: 180.000001 },
      { lat: 41.31, lon: -181 },
    ]) {
      expect(yandexGoCourierUrl(point)).toBeNull();
    }
  });

  it('never sends a start point (Yandex Go uses the tapping person’s location)', () => {
    const url = new URL(yandexGoCourierUrl({ lat: 41.311081, lon: 69.240562 }) ?? '');
    expect(url.searchParams.has('start-lat')).toBe(false);
    expect(url.searchParams.has('start-lon')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual([
      'end-lat',
      'end-lon',
      'tariffClass',
      'level',
      'ref',
      'appmetrica_tracking_id',
      'lang',
    ]);
  });
});
