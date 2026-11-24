/**
 * Yandex Go courier deep link for an order's drop-off point.
 *
 * The same builder exists in `services/telegram/tgcloud/lib/notifications/yandexGo.js`; both must
 * produce identical URLs. Only the destination is sent (`end-lat`/`end-lon`, 6 decimals): Yandex Go
 * uses the location of whoever taps the link as the pickup point. `tariffClass` is the documented
 * tariff parameter and `level` its older name; both are sent. `appmetrica_tracking_id` identifies
 * the Yandex Go app. Whether `courier` opens the courier tariff is not verified on a device.
 */

const YANDEX_GO_ROUTE_URL = 'https://3.redirect.appmetrica.yandex.com/route';
const YANDEX_GO_APPMETRICA_TRACKING_ID = '1178268795219780156';

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** The deep link, or `null` when the point is not a finite WGS84 coordinate pair. */
export function yandexGoCourierUrl(point: { lat: number; lon: number }): string | null {
  if (!isCoordinate(point.lat, 90) || !isCoordinate(point.lon, 180)) return null;
  const query = [
    `end-lat=${point.lat.toFixed(6)}`,
    `end-lon=${point.lon.toFixed(6)}`,
    'tariffClass=courier',
    'level=courier',
    'ref=muniramarket',
    `appmetrica_tracking_id=${YANDEX_GO_APPMETRICA_TRACKING_ID}`,
    'lang=uz',
  ].join('&');
  return `${YANDEX_GO_ROUTE_URL}?${query}`;
}
