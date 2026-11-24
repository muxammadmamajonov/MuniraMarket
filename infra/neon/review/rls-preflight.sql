-- RLS preflight: READ-ONLY. Run each numbered query on its own in the Neon SQL Editor (branch
-- first) and send the result. Nothing is enabled, forced or created. The design is in
-- ../rls-review.md; this file only measures.

-- 1. Per application table: owner, RLS state, existing policy count, what mm_app can do.
SELECT c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       has_table_privilege('mm_app', c.oid, 'SELECT') AS app_select,
       has_table_privilege('mm_app', c.oid, 'INSERT') AS app_insert,
       has_table_privilege('mm_app', c.oid, 'UPDATE') AS app_update,
       has_table_privilege('mm_app', c.oid, 'DELETE') AS app_delete
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'alembic_version'
ORDER BY 1;

-- 2. Does anything bypass RLS? Expect mm_app: bypass_rls = false, superuser = false. The table
--    OWNER (mm_migrator) bypasses RLS unless the table is FORCEd; that is fine for migrations.
SELECT rolname, rolsuper AS superuser, rolbypassrls AS bypass_rls
FROM pg_roles WHERE rolname IN ('mm_app', 'mm_migrator', 'anon', 'authenticated', 'service_role');

-- 3. Which roles other than mm_app can reach the app tables (Data API roles would be the real
--    reason to enable RLS even though the Core API enforces access in code).
SELECT c.relname AS table_name, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
       string_agg(x.privilege_type, ', ' ORDER BY x.privilege_type) AS privileges
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) x
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) NOT IN ('mm_app', 'mm_migrator'))
GROUP BY 1, 2 ORDER BY 1, 2;

-- 4. Foreign keys that cross the user boundary (RLS on a child must agree with its parent).
SELECT conrelid::regclass AS child, confrelid::regclass AS parent,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace
ORDER BY 1, 2;

-- 5. Is the Core API's per-transaction context hook there? The Function sets guards with
--    SET LOCAL per transaction (see rls-review.md); no custom setting exists in the database
--    until a policy references one. Expect no rows.
SELECT name, setting FROM pg_settings WHERE name LIKE 'app.%';

-- 6. Row counts for sizing (planner estimates; no row data).
SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'alembic_version'
ORDER BY 2 DESC, 1;
