# ADR 0012 — Warehouse integration boundary

- Status: accepted (boundary only; no integration exists yet)

## Context

MuniraMarket will eventually connect to an external warehouse platform that knows what is in
stock. No vendor, API or contract is known yet. Today the Core API owns stock: `products.stock_quantity`
is decremented under row locks inside the order transaction (ADR 0009). We want to fix the rules
now, so that whatever vendor arrives plugs into one place and cannot weaken checkout, security or
the existing reliability guarantees.

## Decision

- **Browsers never talk to a warehouse.** The storefront, the Telegram Mini App and the admin UI
  call only their own origin and, through it, the Core API (ADR 0007, 0011). Only the Core API
  talks to the warehouse, through a connector behind an internal port (`WarehouseConnector` in
  `app/domain/warehouse.py`). Vendor credentials exist only in Core API secrets; they are never
  in the repository, a frontend bundle, a log line, an error body or a Telegram message.
- **Who is authoritative.** Until an integration is switched on, the Core API's own stock stays
  the single source of truth, exactly as today. Once integrated, the external warehouse becomes
  authoritative for stock and availability, and the Core API's `stock_quantity` becomes a cache
  refreshed by sync and corrected by reconciliation. The switch is per environment and is
  explicit configuration, never a side effect of deploying code.
- **Checkout stays as it is.** `POST /orders` keeps one transaction: lock the cart row, lock the
  products in ascending id order, re-evaluate with the same pure function as the quote, refuse on
  price change, reserve the slot, insert the order, decrement tracked stock, write status history
  and the outbox row. The `Idempotency-Key` (unique per user, request hash compared, race backed
  by a unique constraint) still decides replays. A warehouse call is never made while holding row
  locks open across a slow network round trip without a bound; the integration adds a reservation
  step keyed by the same identity and keeps the guarantees below.
  - The warehouse reservation is **idempotent and keyed by the order/attempt identity**
    (order id plus the user's `Idempotency-Key`), so a retried request, a replay, or a retried
    outbox job can never reserve twice.
  - An order is **never confirmed if the reservation fails**. A failed or unknown reservation
    leaves no confirmed order and no stock taken; the customer gets a retryable error, and the
    same key can be retried safely.
  - **Compensating cancel.** If the Core API transaction fails after a reservation succeeded, or
    an order is cancelled, a `cancel` with its own idempotency key is issued. Cancels go through
    the outbox (ADR 0008) so they survive crashes and are retried until acknowledged.
  - Delivery of the order advances the warehouse side with `commit`; status history and the
    outbox row remain the audit of what was attempted.
- **Capabilities to implement when the vendor contract exists** (none of them now):
  1. **SKU mapping.** A Core API-owned table maps each product SKU to exactly one external
     warehouse item id (one-to-one both ways). An unknown or ambiguous mapping **fails closed**:
     the product is unavailable, never assumed in stock.
  2. **Idempotent stock sync.** Pull and/or webhook, with a cursor or version and deduplication
     by event id; applying an event twice or out of order must not change the result. Webhooks are
     signed and verified, like ADR 0003.
  3. **Reliability.** Retries with exponential backoff and jitter, a bounded attempt count, and a
     dead-letter state, using the same outbox pattern as ADR 0008 (rows written in the same
     transaction, leased claims, fenced results, at-least-once with idempotent receivers).
  4. **Reserve / commit / cancel** operations, each carrying an idempotency key.
  5. **Reconciliation job** comparing Core API stock and open reservations with the warehouse,
     reporting and repairing drift; and **observability**: metrics for sync lag, reservation
     latency and failures, outbox depth and dead letters, with alerts. Logs carry ids and error
     classes only, no payloads with personal data (ADR 0009).
- **Object storage.** Cloudflare R2 remains the real object storage for product images and
  application objects (ADR 0011). Neon Object Storage may later be used **only** as an optional,
  encrypted, secondary backup copy. It is never the only backup and never the primary store.
- **Seam in code.** `app/domain/warehouse.py` holds frozen value objects and the
  `WarehouseConnector` protocol. It is deliberately not imported anywhere else and changes no
  behaviour; a test fails if something imports it before this decision is implemented.

## Out of scope

This ADR and its PR contain no vendor client, no schema migration, no credentials and no network
calls, and no fake vendor implementation.

## Open questions (for when the vendor contract arrives)

- Vendor, API style (REST, SOAP, files), authentication method and rate limits.
- Does the vendor offer reservations natively, or only stock levels and documents? If only
  documents, what is the equivalent of reserve/commit/cancel?
- Does it guarantee idempotency keys, and for how long are they remembered?
- Push (webhooks, with what signing) or pull only; ordering guarantees; cursor semantics.
- Granularity: single warehouse or several; units of measure, fractional quantities, batches.
- Source of SKUs and who maintains the mapping when products are created in either system.
- Behaviour when the vendor is down: fail checkout closed (default here) or sell from cache for
  a limited time, and how long.
- Sandbox availability, data residency, and expected volumes for sizing sync and reconciliation.

## Consequences

- A vendor can be added by implementing one protocol plus a mapping table and sync jobs, without
  touching the browser-facing surface or the checkout rules.
- Failing closed on missing mappings and failed reservations can reduce sales during outages in
  exchange for never overselling; that trade-off is revisited per the open questions above.
- Until then nothing changes: stock is still the Core API's, and the seam is inert.
