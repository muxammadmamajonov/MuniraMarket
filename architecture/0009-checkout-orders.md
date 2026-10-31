# ADR 0009 — Checkout, delivery zones, idempotent orders and stock

- Status: accepted

## Context

Phase 3 turns the cart into orders for Tashkent home delivery, paid in cash or by card on
delivery. The cart never reserved stock (phase 2). Customers retry on flaky mobile networks and
Telegram Mini App buttons can fire twice; prices and stock can change between looking at the
total and pressing "order".

## Decision

- **Zones by district.** A delivery zone is a set of whole Tashkent districts
  (`delivery_zone_districts`, the district is the primary key, so a district is in at most one
  zone) with a flat fee, an optional free-delivery threshold, a minimum order and local
  Asia/Tashkent hours. No geocoding or map API. Inactive zones do not deliver. Orders are accepted
  around the clock; outside hours they are delivered from the next opening. Pricing and matching
  are pure functions (`app/domain/delivery.py`, `app/domain/checkout.py`).
- **One evaluation for quote and order.** `POST /checkout/quote` and `POST /orders` run the same
  function over the live cart (product active + visible category, current price, tracked stock).
  The quote reports problems instead of failing; the order refuses them. The client sends back the
  total it showed (`expected_total_uzs`); any difference is `409 price_changed`, never a silent
  charge.
- **Idempotency.** `POST /orders` requires an `Idempotency-Key` (unique per user). The same key and
  the same validated body returns the original order (`200`, `Idempotent-Replayed: true`); the
  same key with another body is `409 idempotency_key_conflict`. The key check runs under the
  cart lock, and a unique constraint backs it for the race.
- **Stock under locks.** In one transaction: lock the user's cart row, then the products in id
  order (`FOR UPDATE`), re-check, decrement tracked stock (a `CHECK` keeps it non-negative),
  snapshot name/SKU/unit/price into `order_items`, empty the cart, write the status history and
  the outbox row (ADR 0008). Cancelling — by the customer while `NEW`/`CONFIRMED`, or by an
  operator from any non-final status, always with a reason — returns tracked stock.
- **Lifecycle.** `NEW → CONFIRMED → PICKING → READY_FOR_DELIVERY → OUT_FOR_DELIVERY → DELIVERED`,
  `CANCELLED` from any non-final status; every change appends to `order_status_history` (actor
  role, reason). Operators send the status they saw (`expected_status`) and get
  `409 order_status_conflict` instead of overwriting a colleague.
- **Authorization.** Customer order routes filter by the signed-in user, so another customer's
  order is a plain `404` (no IDOR oracle). `/admin/orders` requires the `operator` or `admin`
  role, re-read from the database on every request, and a Login Widget session (a Mini App
  `initData` session is a storefront credential and is refused); the admin web app is not the
  boundary. A customer may hold at most 5 unconfirmed (`NEW`) orders.
- **PII.** Recipient name, phone and address live only in the order row; logs carry order ids and
  error class names (database errors without bound parameters or row details), the outbox payload
  carries neither address nor phone.

## Consequences

- Concurrent orders for the last units are serialised per product: exactly the available
  quantity sells, the rest get `409 insufficient_stock`.
- Money columns are integer UZS with `total = subtotal + delivery_fee` and
  `line_total = unit_price × quantity` enforced by the database.
- Payment is cash/card on delivery only; online payment is a later phase and will need its own
  ADR (provider, webhooks, refunds).
