import { describe, expect, it } from 'vitest';
import { isGeoPoint, yandexGoCourierUrl } from '../tgcloud/lib/notifications/yandexGo.js';

const TAIL =
  'tariffClass=courier&level=courier&ref=muniramarket' +
  '&appmetrica_tracking_id=1178268795219780156&lang=uz';

describe('yandexGoCourierUrl', () => {
  it('builds exactly the contract URL (destination only)', () => {
    expect(yandexGoCourierUrl({ lat: 41.311081, lon: 69.240562 })).toBe(
      'https://3.redirect.appmetrica.yandex.com/route?end-lat=41.311081&end-lon=69.240562' +
        '&tariffClass=courier&level=courier&ref=muniramarket' +
        '&appmetrica_tracking_id=1178268795219780156&lang=uz',
    );
  });

  it('formats coordinates with exactly six decimals', () => {
    expect(yandexGoCourierUrl({ lat: 41.3, lon: 69 })).toBe(
      `https://3.redirect.appmetrica.yandex.com/route?end-lat=41.300000&end-lon=69.000000&${TAIL}`,
    );
    expect(yandexGoCourierUrl({ lat: 41.31108149, lon: 69.24056251 })).toContain(
      'end-lat=41.311081&end-lon=69.240563&',
    );
    expect(yandexGoCourierUrl({ lat: -33.8688, lon: -151.2093 })).toContain(
      'end-lat=-33.868800&end-lon=-151.209300&',
    );
  });

  it('accepts the range bounds', () => {
    expect(yandexGoCourierUrl({ lat: 90, lon: 180 })).toContain(
      'end-lat=90.000000&end-lon=180.000000&',
    );
    expect(yandexGoCourierUrl({ lat: -90, lon: -180 })).toContain(
      'end-lat=-90.000000&end-lon=-180.000000&',
    );
  });

  it('never sends a start point', () => {
    const url = yandexGoCourierUrl({ lat: 41.311081, lon: 69.240562 });
    expect(url).not.toMatch(/start-lat|start-lon/);
  });

  it.each([
    ['NaN latitude', { lat: Number.NaN, lon: 69 }],
    ['infinite longitude', { lat: 41, lon: Number.POSITIVE_INFINITY }],
    ['latitude above 90', { lat: 90.000001, lon: 69 }],
    ['latitude below -90', { lat: -91, lon: 69 }],
    ['longitude above 180', { lat: 41, lon: 180.5 }],
    ['longitude below -180', { lat: 41, lon: -181 }],
    ['string coordinates', { lat: '41.3', lon: '69.2' }],
    ['missing longitude', { lat: 41 }],
    ['null coordinates', { lat: null, lon: null }],
  ])('returns null for %s', (_label, point) => {
    expect(yandexGoCourierUrl(point)).toBeNull();
  });

  it.each([null, undefined, 42, 'x', []])('returns null for a non-object %j', (point) => {
    expect(yandexGoCourierUrl(point)).toBeNull();
    expect(isGeoPoint(point)).toBe(false);
  });
});
