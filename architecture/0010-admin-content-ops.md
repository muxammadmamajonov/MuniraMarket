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
  (catalog, prices, stock, zones, slots, roles, order status). Database triggers reject `UPDATE`,
  `DELETE` and `TRUNCATE`. They guard against application mistakes only: the table owner can
  disable or drop them, so real tamper resistance needs the API to run as a database role with
  only `INSERT`/`SELECT` on `audit_log` (and no ownership of it). That is a deployment item. `details` is built from an allow-list of field names with scalar values and a
  deny-list for anything personal: no phone numbers, addresses, names, free-text reasons, Telegram
  `initData`, cookies or tokens. An order cancellation records `has_reason`, not the reason.
- **Products are never deleted.** "Delete" archives (`archived_at`, and a `CHECK` that an archived
  product is inactive), so order lines and their snapshots keep their product reference. Archived
  products disappear from the storefront through the existing visibility rule.
- **Images without fetching.** Until object storage arrives, an image is an `https` URL on a public
  host name (no IP literals, including hosts a browser parses as IPv4 such as `127.0.0.0x1` or
  `2130706433`: WHATWG "ends in a number", plus no `0x` labels; no internal suffixes, no
  credentials, default port) or nothing (the UI shows a placeholder). The server never requests
  the URL.
- **No invisible text in names.** Product, category and zone names and product descriptions
  refuse Unicode format characters (`Cf`: bidi overrides such as U+202E, zero-width characters,
  U+FEFF), so two names cannot look identical while differing and text cannot be shown reversed;
  names also refuse line separators and invisible filler letters. JSON and CSV share the check.
- **CSV import is all-or-nothing.** Upsert by SKU; the file (≤ 1 MiB, ≤ 2000 rows, UTF-8, strict
  dialect, exact header) is validated completely first and every problem is reported per row and
  column; if anything is wrong nothing is written. A dry run validates without writing. Applying
  re-validates under product row locks in one transaction. Export quotes every cell (spreadsheets
  in ru/uz locales split on `;`, so an unquoted `Olma;=1+1` would become a formula cell) and
  prefixes every text cell that starts with `=`, `+`, `-`, `@`, tab or carriage return with `'`
  (spreadsheet formula injection); import un-escapes that form and rejects unescaped formula-like
  text.
- **No lost updates through CSV.** Export ends each row with the product's `updated_at` (UTC,
  microseconds). Importing a row whose non-empty `updated_at` differs from the product's current
  one is refused (`stale_row`): otherwise re-importing an older file would set stock back after
  orders took it (stock changes bump `updated_at`), or revert another admin's edit. The check runs
  in dry runs and under the product locks when applying; an empty `updated_at` (new products, or a
  deliberate overwrite) and files without the column skip it.
- **Slots cannot be oversold.** A slot has `capacity` and `reserved_count`, and a check
  constraint keeps `reserved_count <= capacity`. Placing an order reserves with one conditional
  `UPDATE` (only while `reserved_count < capacity` and the slot is bookable) after the product
  locks (lock order: cart or order → products → slot); no row means `409 slot_full` or
  `slot_unavailable`. "Bookable" has one definition shared by the requirement, the quote's offer
  and the booking: active, cutoff in the future, dated within the 14 local days the quote shows.
  So a zone requires a slot only when it can offer one, and a slot outside the window cannot be
  booked.
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
- Deleting a zone or slot that is still referenced is `409 zone_in_use` / `slot_in_use`, also when
  a referencing row wins a race against the delete (the `RESTRICT` foreign key decides).
- A CSV exported before any change to a product must be exported again (or its `updated_at`
  cleared) before it can be imported.
- Real image upload (object storage, resizing, content-type checks) is deferred to the deployment
  phase.
