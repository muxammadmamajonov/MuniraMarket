-- O5: what exists in the live database, and what PUBLIC (everyone) and the helper roles can do.
-- READ-ONLY: every statement is a SELECT on catalog views. No application row is read, nothing is
-- revoked or granted. Run each numbered query on its own in the Neon SQL Editor (branch first),
-- then send the results back. Paste only names, not connection strings.
--
-- Why: neon.ts declares only the `coreapi` Function (plus Auth and the Data API so an apply never
-- disables them). The live branch also has other Functions, Neon Auth, the Data API, Realtime and
-- buckets with no source here, and 02-database.sql revokes PUBLIC privileges, which could affect
-- the Data API and Neon Auth. These queries show what is really there before anyone changes it.

-- 1. Who am I, which database, which server version.
SELECT current_user AS connected_as, current_database() AS db, version() AS server_version;

-- 2. Schemas (an unexpected one, such as neon_auth or a Data API schema, shows here).
SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
       has_schema_privilege('mm_app', n.oid, 'USAGE') AS mm_app_usage,
       has_schema_privilege('public', n.oid, 'USAGE') AS public_usage,
       has_schema_privilege('public', n.oid, 'CREATE') AS public_create
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
ORDER BY 1;

-- 3. Relations outside `public`, with owner and size (names and counts only).
SELECT n.nspname AS schema, c.relname AS name,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' ELSE c.relkind::text END AS kind,
       pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled,
       c.reltuples::bigint AS approx_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname NOT IN ('information_schema', 'public')
  AND c.relkind IN ('r', 'p', 'v', 'm')
ORDER BY 1, 2;

-- 4. Application tables in `public`, with owner (expect mm_migrator) and RLS state.
SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       c.reltuples::bigint AS approx_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY 1;

-- 5. Roles: login roles and the ones the Data API / Neon Auth create. No password data.
SELECT r.rolname, r.rolcanlogin AS can_login, r.rolsuper AS superuser, r.rolcreatedb AS createdb,
       r.rolcreaterole AS createrole, r.rolbypassrls AS bypass_rls, r.rolconnlimit AS conn_limit
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\_%'
ORDER BY 1;

-- 6. Role memberships (is anything a member of neon_superuser or mm_migrator?).
SELECT pg_get_userbyid(m.roleid) AS role, pg_get_userbyid(m.member) AS member,
       m.admin_option
FROM pg_auth_members m
WHERE pg_get_userbyid(m.roleid) NOT LIKE 'pg\_%'
ORDER BY 1, 2;

-- 7. PUBLIC on the database (expect: no CONNECT/TEMPORARY after 02-database.sql).
SELECT datname, has_database_privilege('public', datname, 'CONNECT') AS public_connect,
       has_database_privilege('public', datname, 'TEMPORARY') AS public_temporary,
       has_database_privilege('public', datname, 'CREATE') AS public_create
FROM pg_database WHERE datname = current_database();

-- 8. PUBLIC (and the usual Data API roles) on every table, view and sequence outside the system
--    schemas: one row per object where any of them holds a privilege. Expect NO rows for
--    PUBLIC; rows for `anon` / `authenticated` mean the Data API can reach that object.
SELECT n.nspname AS schema, c.relname AS name, a.grantee_name AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL (
  SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee_name,
         x.privilege_type
  FROM aclexplode(c.relacl) x
) a
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  AND (a.grantee_name = 'PUBLIC' OR a.grantee_name IN ('anon', 'authenticated', 'service_role'))
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 9. Every grant mm_app holds on `public` tables (expect: DML on application tables, SELECT+INSERT
--    only on audit_log, nothing on alembic_version, no TRUNCATE/TRIGGER/REFERENCES).
SELECT c.relname AS name,
       string_agg(x.privilege_type, ', ' ORDER BY x.privilege_type) AS mm_app_privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) x
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND x.grantee = 'mm_app'::regrole
GROUP BY 1
ORDER BY 1;

-- 10. Default privileges (what future tables get, and for whom).
SELECT pg_get_userbyid(d.defaclrole) AS creator_role,
       COALESCE(n.nspname, '(all schemas)') AS schema,
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
            WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' END AS object_type,
       CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
       x.privilege_type
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) x
ORDER BY 1, 2, 3, 4, 5;

-- 11. Functions callable by PUBLIC outside the system schemas (EXECUTE is granted to PUBLIC by
--     default, so this lists everything unless it was revoked). SECURITY DEFINER ones matter most.
SELECT n.nspname AS schema, p.proname AS function,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  AND n.nspname NOT IN (SELECT nspname FROM pg_namespace WHERE nspowner = 10)
  AND p.prokind IN ('f', 'p')
ORDER BY 1, 2;

-- 12. Extensions (pg_trgm is expected; anything else is worth a look).
SELECT e.extname AS extension, e.extversion AS version, n.nspname AS schema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY 1;

-- 13. Publications (Realtime / logical replication expose table changes).
SELECT p.pubname, p.puballtables AS all_tables,
       p.pubinsert, p.pubupdate, p.pubdelete
FROM pg_publication p ORDER BY 1;

SELECT pt.pubname, pt.schemaname, pt.tablename
FROM pg_publication_tables pt ORDER BY 1, 2, 3;

-- 14. Policies that already exist (expect none today).
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies ORDER BY 1, 2, 3;

-- 15. Triggers on application tables (expect audit_log's append-only triggers; others are news).
SELECT c.relname AS table_name, t.tgname AS trigger, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
ORDER BY 1, 2;
