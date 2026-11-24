-- S2: the runtime role must not be able to DELETE order history.
--
-- Today `10-runtime-grants.sql` runs `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO
-- mm_app`, then takes audit_log back to SELECT, INSERT. So mm_app can still delete rows from
-- orders, order_items and order_status_history (and the foreign keys cascade from orders).
--
-- Evidence that the application never needs it (services/core-api-function/src, checked by
-- search): DELETE statements exist only for auth_sessions, oidc_login_states, user_addresses,
-- cart_items, categories, rate_limit_counters and service_request_nonces. Nothing deletes
-- orders, order_items or order_status_history. Cascades run with the table owner's rights, so
-- they are unaffected, and orders.user_id is ON DELETE RESTRICT (a user with orders cannot be
-- deleted either). The test harness truncates as the owner, not mm_app.
--
-- NOT touched on purpose (decide separately): order_item_adjustments (same nature: append-only
-- history, no DELETE in the code, a candidate for the same revoke) and notification_outbox (a
-- retention job may need DELETE).
--
-- WHO RUNS IT: REVOKE only removes privileges the *current role* may revoke. The tables are owned
-- by mm_migrator, and mm_app's grants were made by mm_migrator (10-runtime-grants.sql), so
-- the revoke must run as mm_migrator. The SQL Editor connects as the project owner, which is not
-- a member of mm_migrator. Try the dry run first: its STEP 3 shows whether the privilege is
-- really gone. If STEP 3 still says DELETE = true, the Editor role cannot do it; use one of:
--   (a) psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f this file (the preferred, normal path); or
--   (b) in the Editor, temporarily `GRANT mm_migrator TO <editor role>;` then `SET ROLE
--       mm_migrator;` at the top of the transaction, and `REVOKE mm_migrator FROM <editor
--       role>;` right after COMMIT (the README asks that the owner never keeps that membership).
--
-- Both blocks below are idempotent: REVOKE of a privilege that is not held is a no-op.

------------------------------------------------------------------------------------------------
-- STEP 0 (read-only, run alone): current state. Expect delete_allowed = true before the change.
------------------------------------------------------------------------------------------------
SELECT c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner,
       has_table_privilege('mm_app', c.oid, 'SELECT') AS select_allowed,
       has_table_privilege('mm_app', c.oid, 'INSERT') AS insert_allowed,
       has_table_privilege('mm_app', c.oid, 'UPDATE') AS update_allowed,
       has_table_privilege('mm_app', c.oid, 'DELETE') AS delete_allowed
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orders', 'order_items', 'order_status_history')
ORDER BY c.relname;

------------------------------------------------------------------------------------------------
-- STEP 1: DRY RUN (run as ONE block). Changes nothing: it ends with ROLLBACK.
-- Read the NOTICE lines and the result of STEP 0 again afterwards: nothing may have changed.
------------------------------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mm_app') THEN
    RAISE EXCEPTION 'role mm_app does not exist: wrong database or branch?';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('orders', 'order_items', 'order_status_history')) <> 3 THEN
    RAISE EXCEPTION 'expected public.orders, order_items and order_status_history: wrong schema?';
  END IF;
END
$$;

REVOKE DELETE ON TABLE public.orders, public.order_items, public.order_status_history FROM mm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'order_items', 'order_status_history'] LOOP
    IF has_table_privilege('mm_app', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'DELETE is still granted on % (this role cannot revoke it, see WHO RUNS IT)', t;
    END IF;
    IF NOT (has_table_privilege('mm_app', 'public.' || t, 'SELECT')
            AND has_table_privilege('mm_app', 'public.' || t, 'INSERT')
            AND has_table_privilege('mm_app', 'public.' || t, 'UPDATE')) THEN
      RAISE EXCEPTION 'SELECT/INSERT/UPDATE on % was lost: stop', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'dry run ok: DELETE revoked, SELECT/INSERT/UPDATE kept on all three tables';
END
$$;

ROLLBACK;

------------------------------------------------------------------------------------------------
-- STEP 2: THE CHANGE (run as ONE block, only after the dry run passed on the branch and the
-- application's integration tests passed against a branch with this grant; see the S2 handoff).
------------------------------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE DELETE ON TABLE public.orders, public.order_items, public.order_status_history FROM mm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'order_items', 'order_status_history'] LOOP
    IF has_table_privilege('mm_app', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'DELETE is still granted on %: rolling back', t;
    END IF;
    IF NOT (has_table_privilege('mm_app', 'public.' || t, 'SELECT')
            AND has_table_privilege('mm_app', 'public.' || t, 'INSERT')
            AND has_table_privilege('mm_app', 'public.' || t, 'UPDATE')) THEN
      RAISE EXCEPTION 'SELECT/INSERT/UPDATE on % was lost: rolling back', t;
    END IF;
  END LOOP;
END
$$;

COMMIT;

------------------------------------------------------------------------------------------------
-- STEP 3 (read-only, run alone): verification. Expect delete_allowed = false on all three rows,
-- the other three true, and no row in the second query.
------------------------------------------------------------------------------------------------
SELECT c.relname AS table_name,
       has_table_privilege('mm_app', c.oid, 'SELECT') AS select_allowed,
       has_table_privilege('mm_app', c.oid, 'INSERT') AS insert_allowed,
       has_table_privilege('mm_app', c.oid, 'UPDATE') AS update_allowed,
       has_table_privilege('mm_app', c.oid, 'DELETE') AS delete_allowed
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orders', 'order_items', 'order_status_history')
ORDER BY c.relname;

-- Column-level or PUBLIC grants that would re-open DELETE (expect no rows).
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('orders', 'order_items', 'order_status_history')
  AND privilege_type = 'DELETE'
  AND grantee IN ('mm_app', 'PUBLIC');

------------------------------------------------------------------------------------------------
-- ROLLBACK of the change (only if something needs DELETE after all; same "who runs it" rule):
------------------------------------------------------------------------------------------------
-- BEGIN;
-- GRANT DELETE ON TABLE public.orders, public.order_items, public.order_status_history TO mm_app;
-- COMMIT;

------------------------------------------------------------------------------------------------
-- MAKE IT STICK (a repo change for AFTER the production run is verified; not applied by this
-- file): `10-runtime-grants.sql` runs after every migration and starts with `GRANT ... DELETE ON
-- ALL TABLES`, so the next migration would put DELETE back. Add, right after the audit_log lines:
--
--   REVOKE DELETE ON TABLE public.orders, public.order_items, public.order_status_history
--     FROM mm_app;
--
-- and to 20-verify-runtime-role.sql, a check that has_table_privilege('mm_app', t, 'DELETE') is
-- false for those three tables. `infra/neon/scripts/verify-roles.sh` (CI) then proves it.
------------------------------------------------------------------------------------------------
