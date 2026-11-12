# Yandex Maps in the storefront

The delivery chooser's map step (`components/address-picker.tsx`) uses the **Yandex Maps
JavaScript API v3** (`ymaps3`) for the map itself and Yandex's **Geocoder HTTP API** for the
one confirmed reverse lookup:

1. **The map itself**: tiles, panning, zoom, the theme. The customer moves the map under our own
   centre pin, or taps "My location" (the only place the browser's Geolocation API is called).
2. **Reverse geocoding** of the one point the customer confirms with "Deliver here": a
   `kind=district` request to the Geocoder HTTP API (`reverse-geocode.ts`). The result is matched
   to one of the twelve Tashkent districts
   (`lib/delivery/district-match.ts`), and the district is checked against the live zones from
   `GET /delivery/zones` (`lib/delivery/coverage.ts`).

Only the zones API decides "we deliver here". If the lookup fails for any reason (no key, the key
lacks the Geocoder product, HTTP 403, quota, timeout, offline or a CSP block), the picker says it
could not check the district and sends the customer to the district
list. It never guesses.

## Configuration

| Setting                          | Where                                      | Notes                                                                                                                                             |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YANDEX_MAPS_JAVASCRIPT_API_KEY` | runtime env of the web app (Worker secret) | Loads the map script. It reaches the browser in the script URL, so it is protected by HTTP Referer restriction, not secrecy.                      |
| `YANDEX_MAPS_GEOCODER_API_KEY`   | runtime env of the web app (Worker secret) | Authorizes the one confirmed-point Geocoder HTTP reverse-geocoding request. It reaches the browser too, so receives the same Referer restriction. |
| Never commit either key          | `.env.example` keeps empty values          | CI and the E2E specs never use real keys (see below).                                                                                             |

Without the JavaScript key, nothing is loaded from Yandex, the CSP does not list Yandex hosts, and
the map step shows its own "use the list" fallback. Without the Geocoder key, the map remains
available but a customer must pick a district from the list.

## What the key needs in the Yandex Developer Dashboard

- **Products**: create separate keys for **JavaScript API** and **Geocoder API**. The JavaScript
  key loads the v3 map; the Geocoder key authorizes the HTTP reverse-geocode request.
- **HTTP Referer restriction**: give both keys the exact production storefront entry
  `muniramarket.uz` (no scheme, path or trailing slash). The admin hostname does not use Maps.
- **HTTP Referer restriction**: list every origin that serves the storefront (production domain,
  staging domain, `localhost:3000` only on a development key). The Telegram Mini App loads the
  same origin inside Telegram's WebView, so no extra entry is needed for it.
- **Billing / terms**: the free tier of the JavaScript API has a daily request limit and terms of
  use that restrict commercial and logistics/delivery use; an online shop with delivery is likely
  to need the paid (commercial) licence. Each "Deliver here" is one Geocoder request; map tiles
  count separately per Yandex's billing rules. Confirm the plan and limits with Yandex before
  production; this note is not legal or billing advice.
- **Data use**: the map point is used only to find the district. It is sent to Yandex once (the
  Geocoder request) and nowhere else: not to our API, not to the database, not on the order.
  Only the district code chosen by the customer is saved (`lib/delivery/district-preference.ts`)
  and sent with checkout. Storing coordinates on orders would need a separate privacy, consent
  and Yandex licence review.

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

Without a key none of these hosts appear (`csp.test.ts` checks both cases). If a real-key test
still shows a CSP violation in the console, the lookup fails safely (list fallback); add the
reported host to `config.ts` and `csp.ts`.

## Privacy rules (enforced by tests)

- Geolocation is requested only when "My location" is tapped; the result only re-centres the map.
- The point is used only after "Deliver here", for one request to Yandex.
- Coordinates are never written to `localStorage`, `sessionStorage`, cookies, logs, analytics,
  URLs or our API. Errors from the SDK are swallowed without their message.

## Tests

- Unit tests use the fake map SDK plus a mocked Geocoder HTTP boundary in `test-helpers.ts`.
- Playwright (`e2e/delivery-map.spec.ts`) serves a stub `ymaps3` from `page.route` for
  `https://api-maps.yandex.ru/**` and aborts every other Yandex request. Those specs need the web
  server started with a **placeholder** key (`00000000-0000-4000-8000-000000000000`) and
  `E2E_MAPS_STUB=1`; they skip otherwise. No real key is ever used in CI.
