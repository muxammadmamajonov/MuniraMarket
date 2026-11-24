# Yandex Maps in the storefront

The delivery address picker (`components/address-picker.tsx`) uses the **Yandex Maps JavaScript
API v3** (`ymaps3`) for the map itself and Yandex's **Geocoder HTTP API** to turn the pin into a
street and house:

1. **The map itself**: tiles, panning, zoom, the theme. The customer moves the map under our own
   centre pin, or taps "Mening joylashuvim" (the only place the Geolocation API is called).
2. **Reverse geocoding** of the pin each time the map comes to rest (debounced): a `kind=house`,
   `results=1` request to the Geocoder HTTP API (`reverse-geocode.ts`). Street and house of the
   nearest building fill the form, so the customer mostly confirms. If the lookup fails for any
   reason (no key, the key lacks the Geocoder product, HTTP 403, quota, timeout, offline or a CSP
   block) the customer types them; the pin is still the delivery point.

"Shu yerga yetkazish" saves the address (`lib/address/address.ts`): the pin's latitude/longitude
plus street, house, apartment, entrance, floor and a landmark/comment. Delivery is done by a Yandex
Go courier, so nothing about areas, fees or free-delivery thresholds is shown or checked.

## Configuration

| Setting                          | Where                                      | Notes                                                                                                                        |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `YANDEX_MAPS_JAVASCRIPT_API_KEY` | runtime env of the web app (Worker secret) | Loads the map script. It reaches the browser in the script URL, so it is protected by HTTP Referer restriction, not secrecy. |
| `YANDEX_MAPS_GEOCODER_API_KEY`   | runtime env of the web app (Worker secret) | Authorizes the reverse-geocoding requests. It reaches the browser too, so receives the same Referer restriction.             |
| Never commit either key          | `.env.example` keeps empty values          | CI and the E2E specs never use real keys (see below).                                                                        |

Without the JavaScript key, nothing is loaded from Yandex, the CSP does not list Yandex hosts, and
the picker shows its own "map unavailable" panel. Every order needs a map point, so **the
JavaScript key is required in production**. Without the Geocoder key, the map works and the
customer types street and house.

## What the key needs in the Yandex Developer Dashboard

- **Products**: create separate keys for **JavaScript API** and **Geocoder API**.
- **HTTP Referer restriction**: list every origin that serves the storefront (production domain,
  staging domain, `localhost:3000` only on a development key). The Telegram Mini App loads the
  same origin inside Telegram's WebView, so no extra entry is needed for it.
- **Billing / terms**: the free tier has daily request limits and terms that restrict commercial
  and delivery use, and limit storing Geocoder results. The app now stores the customer's own pin
  and the street/house they confirmed on each order, and sends one Geocoder request per map stop.
  Confirm the plan, limits and storage terms with Yandex before production; this note is not
  legal or billing advice.

## Data use

- The pin goes to Yandex in the Geocoder request and to our API only inside an order (the order's
  address snapshot keeps `lat`/`lon` so staff can call a Yandex Go courier to it).
- The current address is remembered on this device only (`lib/address/storage.ts`,
  `localStorage`) so checkout starts from it.
- Geolocation is requested only when "Mening joylashuvim" is tapped; the result only re-centres
  the map. Coordinates are never written to cookies, logs, analytics or URLs. Errors from the SDK
  are swallowed without their message.

## CSP

`lib/csp.ts` adds map hosts only when the JavaScript key is configured (`yandexMaps === true`), and
adds the reverse-geocoding host only when the Geocoder key is also configured (`yandexGeocoder ===
true`), using the constants in `config.ts`:

- `script-src https://api-maps.yandex.ru` (`YANDEX_MAPS_API_ORIGIN`, for browsers without
  `'strict-dynamic'`);
- `style-src https://yastatic.net` (`YANDEX_MAPS_STATIC_ORIGIN`, the JavaScript API's own
  stylesheet host);
- `connect-src https://api-maps.yandex.ru https://*.maps.yandex.net`, plus
  `https://geocode-maps.yandex.ru` only with the Geocoder key (`YANDEX_MAPS_API_ORIGIN`,
  `YANDEX_MAPS_DATA_ORIGIN`, and `YANDEX_MAPS_GEOCODER_ORIGIN`);
- `worker-src 'self' blob:` (vector tile workers); images are covered by `img-src https:`.

Without a key none of these hosts appear (`csp.test.ts` checks both cases).

## Tests

- Unit tests use the fake map SDK plus a mocked Geocoder HTTP boundary in `test-helpers.ts`.
- Playwright (`e2e/delivery-map.spec.ts`) serves a stub `ymaps3` from `page.route` for
  `https://api-maps.yandex.ru/**`, answers the Geocoder locally and aborts every other Yandex
  request. Those specs need the web server started with a **placeholder** key
  (`00000000-0000-4000-8000-000000000000`) and `E2E_MAPS_BASE_URL`; they skip otherwise. Other
  specs start from a saved address (`seedDeliveryAddress` in `e2e/support.ts`). No real key is
  ever used in CI.
