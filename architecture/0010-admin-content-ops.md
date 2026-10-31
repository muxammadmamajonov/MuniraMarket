# ADR 0010 — Back-office roles, audit log, catalog CSV and delivery slots

- Status: accepted

## Context

Phase 4 lets staff run the shop without database access: edit the catalog (also in bulk), set up
delivery zones and time slots, manage staff roles and watch the day's numbers. These are the most
privileged writes in the system, a mistake in them changes what every customer pays or receives,
and several of them race with checkout.

## Decision

- **Two staff roles, enforced by the API.** `operator` works orders and reads the dashboard;
  `admin` also manages the catalog, zones, slots, users, CSV and reads the audit log. Every
  `/admin/**` route checks the role **re-read from the database** before touching any entity (a
  wrong role gets the same `403` for existing and unknown ids), accepts only Login Widget sessions
  (ADR 0007: a Mini App session is never a back-office credential), and needs the CSRF token on
  writes. The admin web app hides what a role cannot do, but is not a security boundary.
- **Last admin.** Demoting or blocking an admin locks every active admin row (`FOR UPDATE`, id
  order) in the same transaction and refuses the change if no active admin would remain
  (`409 last_admin`); blocking yourself is refused. Two admins demoting each other at once cannot
  both succeed.
- **Append-only audit log.** `audit_log` rows are written in the same transaction as the change
  (catalog, prices, stock, zones, slots, roles, order status). A database trigger rejects `UPDATE`
  and `DELETE`. `details` is built from an allow-list of field names with scalar values and a
  deny-list for anything personal: no phone numbers, addresses, names, free-text reasons, Telegram
  `initData`, cookies or tokens. An order cancellation records `has_reason`, not the reason.
- **Products are never deleted.** "Delete" archives (`archived_at`, and a `CHECK` that an archived
  product is inactive), so order lines and their snapshots keep their product reference. Archived
  products disappear from the storefront through the existing visibility rule.
- **Images without fetching.** Until object storage arrives, an image is an `https` URL on a public
  host name (no IP literals, no internal suffixes, no credentials, default port) or nothing (the
  UI shows a placeholder). The server never requests the URL.
- **CSV import is all-or-nothing.** Upsert by SKU; the file (≤ 1 MiB, ≤ 2000 rows, UTF-8, strict
  dialect, exact header) is validated completely first and every problem is reported per row and
  column; if anything is wrong nothing is written. A dry run validates without writing. Applying
  re-validates under product row locks in one transaction. Export prefixes every text cell that
  starts with `=`, `+`, `-`, `@`, tab or carriage return with `'` (spreadsheet formula injection);
  import un-escapes that form and rejects unescaped formula-like text.
- **Slots cannot be oversold.** A slot has `capacity` and `reserved_count`, and a check
  constraint keeps `reserved_count <= capacity`. Placing an order reserves with one conditional
  `UPDATE` (only while `reserved_count < capacity`, the slot is active and its cutoff is in the
  future) after the product locks (lock order: cart or order → products → slot); no row means `409 slot_full` or `slot_unavailable`.
  Cancelling releases one place in the same transaction as the status change. A zone with bookable
  slots requires one at checkout; a zone without slots keeps phase 3 behaviour. The order keeps a
  snapshot of the booked window.
- **Dashboard numbers come from the server**, in SQL, for the Asia/Tashkent calendar day of the
  API clock.

## Consequences

- Audit rows cannot be corrected, only followed by new ones; retention and export are an
  operational decision for later.
- Slot capacity is a hard limit; raising it is an admin action, lowering it below what is already
  reserved is refused.
- Real image upload (object storage, resizing, content-type checks) is deferred to the deployment
  phase.
