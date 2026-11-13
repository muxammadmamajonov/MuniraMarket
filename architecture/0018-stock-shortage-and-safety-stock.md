# ADR 0018 — Stock shortages: safety stock and adjusting orders at picking

- Status: accepted
- Builds on: [0009](0009-checkout-orders.md), [0008](0008-order-notification-outbox.md),
  [0012](0012-warehouse-integration-boundary.md), [0015](0015-staff-group-and-notification-drain.md)

## Context

The shop floor and the online store sell from the same shelves, but sales at the till are not
recorded in our system. `products.stock_quantity` is therefore only right until a walk-in
customer buys something. Example: 1 kg of apples is left; an online customer orders 1 kg (the
order takes the stock, ADR 0009); meanwhile a walk-in customer takes the same kilogram to the till.
Until now the order simply stayed as it was and staff found the shortage while picking, with no
way to record it: they could only cancel the whole order or deliver less than the order says.

## Options considered

1. **Integrate the till (POS) through the warehouse connector seam (ADR 0012).** Cashier sales
   would decrement the same stock in real time, and the external system would become authoritative
   for stock. This is the real fix, but there is no POS/warehouse vendor, API or contract yet, and
   ADR 0012 requires idempotent sync, reservations and reconciliation before switching. Long term.
2. **Safety stock.** Keep a few units of each product back for walk-in shoppers: the website sells
   `stock_quantity - safety_stock`. Cheap, immediate, tunable per product; it lowers the chance of
   a shortage but cannot remove it (and it hides some sellable stock online).
3. **Adjust the order at picking.** When the goods are not there, staff lower the order line (to 0
   if nothing is left), the totals follow, stock is corrected, and the customer is told and may
   cancel. Handles the shortages that still happen.
4. **Automatic cancellation of the whole order on any shortage.** Simple, but throws away orders
   the customer would still want (one missing item out of ten); rejected as the default. It is
   kept for the one case where nothing is left to deliver (every line at 0).
5. **Hold or re-confirm every online order by phone.** Rejected: slow, and it does not scale.

## Decision

Options 2 and 3 now; option 1 stays the long-term fix and plugs into the ADR 0012 seam unchanged.

- **Safety stock.** `products.safety_stock` (integer, `>= 0`, default 0; migration 0009). For a
  tracked product (`stock_quantity` not null) the online store sells
  `max(stock_quantity - safety_stock, 0)`; an untracked product is unaffected. The repositories
  select this _sellable_ quantity as the storefront's `stock_quantity`, so the catalog, the
  `in_stock` filter, cart validation, the checkout quote and order placement (`insufficient_stock`
  and its `available_quantity`) all use it; placing an order still decrements the physical
  `stock_quantity` under the product lock (ADR 0009). The physical stock and the safety stock
  never reach the storefront. Storefront products gain `low_stock` (1..3 sellable units: "Kam
  qoldi"). Admin products carry `safety_stock` and `sellable_quantity`; the catalog CSV has an
  optional `safety_stock` column (absent: keep; empty: 0) so older files keep working.
- **Adjusting a line at picking.** `PATCH /api/v1/admin/orders/{order_id}/items/{product_id}`
  `{quantity, reason, mark_out_of_stock}` (operator or admin, Login Widget session, CSRF; the same
  rules as other back-office writes). Allowed while the order is `NEW`, `CONFIRMED` or `PICKING`
  (`409 order_not_adjustable` otherwise), only downwards (`0..current quantity`, else
  `409 invalid_quantity`). In one transaction, with the order row locked first and then the
  product (the ADR 0009 lock order):
  - the line keeps the ordered quantity (`original_quantity`, set the first time) and gets the new
    quantity, line total and `adjusted_at`; the order's subtotal, total and item count are
    recomputed;
  - stock: by default the units the line no longer takes go back to the product (only what the
    order actually took, as when cancelling); with `mark_out_of_stock` the product's stock is set
    to 0 instead (the goods physically ran out, the shelf count is wrong anyway);
  - an `order_item_adjustments` row (from/to quantity, reason, out-of-stock flag, actor), an
    `order.item_adjust` audit entry (quantities, SKU, flag; never the reason text), and, when the
    stock was zeroed, a `product.update` audit entry;
  - the outbox gets `order.adjusted` for the customer (their language: what changed, the new
    total, and that they may cancel in the app; the staff's reason is not shown) and
    `order.staff_adjusted` for the staff group;
  - if every line is now 0 the order is cancelled through the normal cancel path (reason
    "Mahsulotlar tugab qoldi"), which writes the history, the audit and the usual cancellation
    messages instead of the adjustment ones.
- **The customer may back out.** A customer can cancel a `NEW`/`CONFIRMED` order as before, and
  now also a `PICKING` order that staff adjusted: they did not agree to the smaller order.
- **Retries and races.** Setting the quantity a line already has changes nothing (a retried or
  doubled request is harmless). The order lock serialises adjustments with status changes, so an
  adjustment either happens before the order leaves `PICKING` or is refused after it.
- **Visibility.** Order lines expose `original_quantity` and `adjusted`; the admin order detail
  lists every adjustment ("Olma: 2 kg → 0 kg, sabab: …") and `can_adjust_items`.

## Consequences

- Fewer shortages reach customers, at the price of a little stock hidden online; the owner tunes
  `safety_stock` per product (fast movers sold at the till need more).
- When a shortage still happens it is recorded, priced and communicated instead of being
  discovered at the door; the order history and audit show who changed what and why.
- An order line may now be 0 and an order's item count may be 0 (only for an order that was
  cancelled because everything ran out). The migration's downgrade restores such lines to their
  original quantity.
- `mark_out_of_stock` makes the product unsellable until someone counts the shelf and sets the
  stock again; that is deliberate (the count was wrong).
- Real stock accuracy still depends on the POS integration (option 1, ADR 0012).
