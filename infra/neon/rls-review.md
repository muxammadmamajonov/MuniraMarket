# Row-level security: inventory, risk and design (document only)

**Status: not enabled, and no policy migration exists.** This file is the inventory and a design
template. Nothing here is applied by CI, a migration or a deploy. Enabling RLS in production needs
its own reviewed change, tested on a Neon branch with the whole integration suite.

## Why it is not a quick win here

- The Core API connects as **one** role, `mm_app`, and enforces "this customer sees only their own
  orders" **in code** (every query filters by the session's user id). Nothing in the database knows
  which customer a request is for.
- `mm_app` is `NOBYPASSRLS` and owns nothing, so as soon as RLS is enabled on a table, **policies
  apply to it**. With no policy, RLS means _deny all_: `SELECT` returns zero rows, `INSERT` fails.
  The storefront would look empty and checkout would fail.
- A policy needs the request's user id inside the database. The Function opens each transaction
  with `SET LOCAL` guards (`src/db.ts` prelude), so a `SET LOCAL app.user_id = '<uuid>'` per
  transaction is feasible, but **`Database.query()` runs outside a transaction** (`pool.query`):
  such a read gets no context. Every such call site must move into a transaction first.
- Neon's pooler is in transaction mode: only `SET LOCAL` is safe; a plain `SET` would leak one
  customer's id to the next request that reuses the connection.
- The table owner `mm_migrator` bypasses RLS unless the table is `FORCE`d, which is what you want
  for migrations and not for `mm_app`.

So RLS here is defence in depth against a bug in the Core API's own filters (or a leaked
`mm_app` URL used by someone who does not set the context), not a replacement for them. It is worth
doing for the customer-data tables; it is not worth doing for the rest. If the Neon **Data API**
is on, RLS (or no grants to `anon`/`authenticated`) is the _only_ protection on that path:
`o5-inventory-and-public-privileges.sql` queries 8 and `review/rls-preflight.sql` query 3 show
whether those roles hold any grant. If they hold none, the Data API cannot read the tables.

## Inventory (17 application tables; `alembic_version` is the migrator's)

Source: Alembic revisions 0001-0009 (0007 dropped `delivery_slots`, `delivery_zones`,
`delivery_zone_districts`). Run `review/rls-preflight.sql` query 1 to confirm the live state.

| Table                     | Class                 | Rows are about         | RLS candidate? | Notes                                                                                    |
| ------------------------- | --------------------- | ---------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `categories`              | public catalog        | nobody                 | No             | Read by anonymous storefront; written by admin through the API.                          |
| `products`                | public catalog        | nobody                 | No             | Same. Inactive/archived products are filtered in code (`is_active`).                     |
| `users`                   | customer data         | the user (`id`)        | Yes, later     | Staff read other users (admin); login looks a user up by Telegram id _before_ a session. |
| `user_addresses`          | customer data         | `user_id`              | Yes            | Clean owner column; only the owner (and staff for an order) reads it.                    |
| `carts`                   | customer data         | `user_id`              | Yes            | One cart per user.                                                                       |
| `cart_items`              | customer data         | via `carts.user_id`    | Yes            | Policy joins to `carts`; it has no user column.                                          |
| `orders`                  | customer data         | `user_id`              | Yes            | Staff read and update all; checkout inserts as the customer.                             |
| `order_items`             | customer data         | via `orders.user_id`   | Yes            | Child of `orders`.                                                                       |
| `order_status_history`    | customer data         | via `orders.user_id`   | Yes            | Child; append-only in practice (see S2).                                                 |
| `order_item_adjustments`  | customer data         | via `orders.user_id`   | Yes            | Child; append-only in practice.                                                          |
| `notification_outbox`     | system, holds PII     | order (phone, address) | No (system)    | Written in checkout, drained by the scheduler; not read by customers. Keep service-only. |
| `staff_notification_chat` | system                | the staff group        | No             | Singleton setting.                                                                       |
| `audit_log`               | staff / append-only   | staff actions          | No             | Already `SELECT, INSERT` only plus triggers (ADR 0010).                                  |
| `auth_sessions`           | system security state | `user_id`, token hash  | No             | Read on every request before any user context exists; only `mm_app` touches it.          |
| `oidc_login_states`       | system security state | nobody                 | No             | Pre-login.                                                                               |
| `rate_limit_counters`     | system security state | IP/key                 | No             | Pre-login.                                                                               |
| `service_request_nonces`  | system security state | service                | No             | Replay protection.                                                                       |

Rule of thumb used above: **a table gets RLS only if every legitimate access already knows the
customer id**. The security-state tables are read _to find out_ who the customer is, so a
per-customer policy would be circular; they stay protected by grants (`mm_app` only).

## Order of work if it is ever done

1. Run `review/rls-preflight.sql` and `review/o5-inventory-and-public-privileges.sql`; decide
   from query 3 / query 8 whether any other role can reach the tables (that is the real exposure).
2. Add the per-transaction context (`SET LOCAL app.user_id`, and `app.role` for staff) in the
   Function's transaction helper, behind a flag, and move every `Database.query()` on a customer
   table into a transaction. No RLS yet; ship and watch.
3. Create the policies and `ENABLE ROW LEVEL SECURITY` for **one** table on a branch
   (`user_addresses` is the smallest), run the full integration suite against it, then widen.
4. Production: one table per change, each preceded by a `pre-migration-<release>` branch and
   followed by a smoke test of sign-in, cart, checkout and the admin order list.

## Preflight and template (documentation only: do not run the templates)

Read-only preflight: `review/rls-preflight.sql`. The templates below are the shape of the change,
with `mm_app` and the setting names as placeholders to settle in step 2.

```sql
-- TEMPLATE, NOT FOR EXECUTION. One table at a time, on a branch, as mm_migrator, in a transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Customer-owned table with a user column (user_addresses, carts, orders):
ALTER TABLE public.user_addresses ENABLE ROW LEVEL SECURITY;
-- FORCE would also bind the owner (mm_migrator); leave it off so migrations keep working.

CREATE POLICY user_addresses_owner ON public.user_addresses
  FOR ALL TO mm_app
  USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Staff (operator / admin) need to read and update every order:
CREATE POLICY orders_staff ON public.orders
  FOR ALL TO mm_app
  USING      (current_setting('app.role', true) IN ('operator', 'admin'))
  WITH CHECK (current_setting('app.role', true) IN ('operator', 'admin'));

-- Child table without a user column (cart_items; same shape for order_items,
-- order_status_history, order_item_adjustments via orders):
CREATE POLICY cart_items_owner ON public.cart_items
  FOR ALL TO mm_app
  USING (EXISTS (SELECT 1 FROM public.carts c
                 WHERE c.id = cart_items.cart_id
                   AND c.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid));

-- Verify, then COMMIT (or ROLLBACK):
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'user_addresses';
ROLLBACK;
```

```sql
-- TEMPLATE, NOT FOR EXECUTION: rollback of one table's RLS.
BEGIN;
DROP POLICY IF EXISTS user_addresses_owner ON public.user_addresses;
ALTER TABLE public.user_addresses DISABLE ROW LEVEL SECURITY;
COMMIT;
```

**If RLS is enabled wrongly the application stops working** (empty lists, failed inserts, 500s
on checkout), and with the pooler a missing `SET LOCAL` shows up as "works for me, empty for
others". Hence: branch first, one table at a time, a flag for the context code, and the disable
statement above ready before each production change.
