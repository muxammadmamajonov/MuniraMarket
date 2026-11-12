# ADR 0017 — On-demand delivery by Yandex Go couriers

- Status: accepted
- Supersedes: the delivery-pricing part of [ADR 0009](0009-checkout-orders.md)

## Context

The store no longer runs its own delivery or charges for it. Each order is carried by a Yandex Go
courier (Yandex Delivery) that staff call when the order is ready, and the customer pays the
courier. Per-area zones, fees, free-delivery thresholds, per-zone minimum orders, working hours and
booked delivery windows no longer describe anything real.

## Decision

- **No delivery pricing in the store.** A checkout quote is the cart: `total_uzs == subtotal_uzs`.
  `POST /checkout/quote` takes no body. Checkout shows one plain line: the order arrives with a
  Yandex courier and the customer pays for delivery on receipt.
- **The address is a map point.** `DeliveryAddress` is `{lat, lon, street, house, apartment?,
entrance?, floor?, landmark?}`; the point is required (WGS84, rounded to 6 decimals). The
  storefront's picker reverse-geocodes the pin (Yandex Geocoder) to prefill street and house. The
  same type and picker are meant for saved addresses.
- **Courier deep link.** For an order with a point, staff get a "Yandex chaqirish" link:
  `https://3.redirect.appmetrica.yandex.com/route?end-lat=…&end-lon=…&tariffClass=courier&level=courier&ref=muniramarket&appmetrica_tracking_id=1178268795219780156&lang=uz`.
  No start point, so Yandex Go starts from the location of whoever taps it. Built by pure,
  unit-tested functions (`packages/contracts/src/yandex-go.ts` for the admin,
  `services/telegram/tgcloud/lib/notifications/yandexGo.js` for the staff group).
- **Staff group alert.** The `order.staff_alert` outbox payload for a NEW order carries
  `destination: {lat, lon}`; the bot adds a URL button with the link. This relaxes ADR 0015's
  "no address in the group": the group now receives the delivery point (inside the button URL),
  still no name or phone.
- **Data.** Migration 0007 drops the zone, zone-area and slot tables and the order columns that
  referenced them, and the per-order fee column. Historical totals are untouched; the CHECK
  becomes `total_uzs >= subtotal_uzs` (old orders still include the fee they were charged, which
  stays recoverable as `total_uzs - subtotal_uzs`).

## Consequences

- An order can only be placed with a map point, so the Yandex Maps JavaScript key is required in
  production.
- `tariffClass=courier` is not in Yandex's public list of passenger tariffs; it must be confirmed
  on a real device. Without the tariff the link still opens a route to the point.
- Orders placed before the migration have no point: staff call the courier from the text address.
- The order now stores the customer's coordinates. Yandex's terms on storing Geocoder results and
  on commercial/delivery use must be confirmed for the paid plan.
