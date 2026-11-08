# Yandex Maps in the storefront

The delivery chooser's map step (`components/address-picker.tsx`) uses the **Yandex Maps
JavaScript API v3** (`ymaps3`) for two things:

1. **The map itself**: tiles, panning, zoom, the theme. The customer moves the map under our own
   centre pin, or taps "My location" (the only place the browser's Geolocation API is called).
2. **Reverse geocoding** of the one point the customer confirms with "Deliver here":
   `ymaps3.search({ text: "lng,lat", type: ["toponyms"], limit: 10 })`
   (`reverse-geocode.ts`). The toponyms are matched to one of the twelve Tashkent districts
   (`lib/delivery/district-match.ts`), and the district is checked against the live zones from
   `GET /delivery/zones` (`lib/delivery/coverage.ts`).

Only the zones API decides "we deliver here". If the lookup fails for any reason (no key, the key
lacks the search product, HTTP 403, quota, timeout, offline, a CSP block, an SDK without
`search`), the picker says it could not check the district and sends the customer to the district
list. It never guesses.

## Configuration

| Setting               | Where                                      | Notes                                                                                                                                                                   |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YANDEX_MAPS_API_KEY` | runtime env of the web app (Worker secret) | Read by `config.ts`; must be UUID-shaped or the map is disabled. Reaches the browser in the script URL, so it is protected by the referrer restriction, not by secrecy. |
| Never commit the key  | `.env.example` keeps an empty value        | CI and the E2E specs never use a real key (see below).                                                                                                                  |

Without a valid key, nothing is loaded from Yandex, the CSP does not list Yandex hosts, and the
map step shows its own "use the list" fallback.

## What the key needs in the Yandex Developer Dashboard

- **Product**: "JavaScript API and HTTP Geocoder" (one key covers the v3 map script).
- **Search (reverse geocoding)**: the v3 reference says `ymaps3.search` needs an API key for the
  Search API set with `ymaps3.getDefaultConfig().setApikeys({ search })`. We pass the same
  `YANDEX_MAPS_API_KEY`. **Unverified**: whether Yandex accepts the JavaScript API key for
  `search` on every plan. If it does not (HTTP 403 from the search endpoint), the map still works
  and the delivery check falls back to the list. The fix then is a key with geosearch enabled; it
  would need its own env var passed through `MapsConfigProvider` (the root layout) and handed to
  `reverseGeocodeDistrict` instead of the map key. Check this against the dashboard before launch.
- **HTTP Referer restriction**: list every origin that serves the storefront (production domain,
  staging domain, `localhost:3000` only on a development key). The Telegram Mini App loads the
  same origin inside Telegram's WebView, so no extra entry is needed for it.
- **Billing / terms**: the free tier of the JavaScript API has a daily request limit and terms of
  use that restrict commercial and logistics/delivery use; an online shop with delivery is likely
  to need the paid (commercial) licence. Each "Deliver here" is one geosearch request; map tiles
  count separately per Yandex's billing rules. Confirm the plan and limits with Yandex before
  production; this note is not legal or billing advice.
- **Data use**: the map point is used only to find the district. It is sent to Yandex once (the
  geosearch request) and nowhere else: not to our API, not to the database, not on the order.
  Only the district code chosen by the customer is saved (`lib/delivery/district-preference.ts`)
  and sent with checkout. Storing coordinates on orders would need a separate privacy, consent
  and Yandex licence review.

## CSP

`lib/csp.ts` adds, only when a key is configured (`yandexMaps === true`), using the constants in
`config.ts`:

- `script-src https://api-maps.yandex.ru` (`YANDEX_MAPS_API_ORIGIN`, for browsers without
  `'strict-dynamic'`);
- `connect-src https://api-maps.yandex.ru https://*.maps.yandex.net https://search-maps.yandex.ru`
  (`YANDEX_MAPS_API_ORIGIN`, `YANDEX_MAPS_DATA_ORIGIN`, and `YANDEX_MAPS_SEARCH_ORIGIN`, the
  geosearch host `ymaps3.search` calls, per the v3 CSP requirements);
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

- Unit tests use the fake SDK in `test-helpers.ts` (`makeYMaps()`; `fake.search` is a mock).
- Playwright (`e2e/delivery-map.spec.ts`) serves a stub `ymaps3` from `page.route` for
  `https://api-maps.yandex.ru/**` and aborts every other Yandex request. Those specs need the web
  server started with a **placeholder** key (`00000000-0000-4000-8000-000000000000`) and
  `E2E_MAPS_STUB=1`; they skip otherwise. No real key is ever used in CI.
