// @ts-check
/**
 * Yandex Go courier deep link for a staff alert (ADR 0015 as amended: the only location that
 * reaches the staff group is the order's destination, inside this button URL).
 *
 * Same builder as `packages/contracts/src/yandex-go.ts` (used by the admin); both must produce the
 * identical string. Pure and dependency-free (no `URL` global in the Telegram runtime).
 *
 * - Only the destination (`end-lat` / `end-lon`, 6 decimals). There is deliberately NO start
 *   point: the Yandex Go app starts the route at the location of whoever taps the button.
 * - `tariffClass=courier` is the documented tariff parameter; `level=courier` is its older name,
 *   sent too. `appmetrica_tracking_id=1178268795219780156` targets the Yandex Go app
 *   (yandex.ru/support/taxi-distr/ru/code-integration). `courier` is not in the documented
 *   passenger tariff list, so the courier preselection is unverified on a device.
 */

export const YANDEX_GO_BASE_URL = 'https://3.redirect.appmetrica.yandex.com/route';
const QUERY_TAIL =
  'tariffClass=courier&level=courier&ref=muniramarket' +
  '&appmetrica_tracking_id=1178268795219780156&lang=uz';

/**
 * @typedef {object} GeoPoint
 * @property {number} lat WGS84 latitude, -90..90
 * @property {number} lon WGS84 longitude, -180..180
 */

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {value is number}
 */
function inRange(value, limit) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}

/**
 * Whether `point` is a usable WGS84 coordinate pair (finite numbers within range).
 * @param {unknown} point
 * @returns {point is GeoPoint}
 */
export function isGeoPoint(point) {
  if (typeof point !== 'object' || point === null || Array.isArray(point)) return false;
  const { lat, lon } = /** @type {Record<string, unknown>} */ (point);
  return inRange(lat, 90) && inRange(lon, 180);
}

/**
 * The Yandex Go "call a courier to this destination" link, or `null` for an unusable point.
 * @param {GeoPoint} point
 * @returns {string | null}
 */
export function yandexGoCourierUrl(point) {
  if (!isGeoPoint(point)) return null;
  return (
    `${YANDEX_GO_BASE_URL}?end-lat=${point.lat.toFixed(6)}&end-lon=${point.lon.toFixed(6)}` +
    `&${QUERY_TAIL}`
  );
}
