-- cleanup-authenticated-grants.sql
--
-- Removes direct privileges held by the roles `anonymous` and `authenticated`
-- on public tables, sequences and functions, and removes the matching default
-- privileges configured for the table-owner role `mm_migrator`.
--
-- Run as `mm_migrator` (the grantor of these privileges). REVOKE only removes
-- grants made by the current role, and ALTER DEFAULT PRIVILEGES FOR ROLE
-- mm_migrator requires being that role (or a member of it). If another grantor
-- still holds entries, the verification block below aborts and rolls back.
--
-- Not touched: role memberships, neon_service, RLS policies, schema USAGE.
--
-- Usage (connection supplied by the operator at run time):
--   psql "$DATABASE_URL" -f cleanup-authenticated-grants.sql

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Revoke existing direct privileges.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anonymous, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anonymous, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anonymous, authenticated;

-- 2. Revoke default privileges for objects created later by mm_migrator
--    (both schema-scoped and global defaults).
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
    REVOKE ALL ON TABLES    FROM anonymous, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anonymous, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM anonymous, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator
    REVOKE ALL ON TABLES    FROM anonymous, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator
    REVOKE ALL ON SEQUENCES FROM anonymous, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator
    REVOKE ALL ON FUNCTIONS FROM anonymous, authenticated;

-- 3. Verify nothing remains; any leftover raises an exception, which (with
--    ON_ERROR_STOP) aborts the script before COMMIT so the transaction rolls back.
DO $verify$
DECLARE
    remaining_relation_acl integer;
    remaining_column_acl   integer;
    remaining_function_acl integer;
    remaining_default_acl  integer;
BEGIN
    -- Tables, views, matviews, foreign tables and sequences in public.
    SELECT count(*) INTO remaining_relation_acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND r.rolname IN ('anonymous', 'authenticated');

    -- Column-level grants on public relations.
    SELECT count(*) INTO remaining_column_acl
    FROM pg_attribute at
    JOIN pg_class c ON c.oid = at.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(at.attacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
      AND at.attacl IS NOT NULL
      AND r.rolname IN ('anonymous', 'authenticated');

    -- Functions and procedures in public.
    SELECT count(*) INTO remaining_function_acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
      AND r.rolname IN ('anonymous', 'authenticated');

    -- Default ACLs for mm_migrator: public-schema and global (namespace 0).
    SELECT count(*) INTO remaining_default_acl
    FROM pg_default_acl d
    JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE owner_role.rolname = 'mm_migrator'
      AND (d.defaclnamespace = 0
           OR d.defaclnamespace = 'public'::regnamespace)
      AND d.defaclobjtype IN ('r', 'S', 'f')
      AND r.rolname IN ('anonymous', 'authenticated');

    IF remaining_relation_acl + remaining_column_acl
       + remaining_function_acl + remaining_default_acl > 0 THEN
        RAISE EXCEPTION
            'cleanup incomplete: relation_acl=%, column_acl=%, function_acl=%, default_acl=%',
            remaining_relation_acl, remaining_column_acl,
            remaining_function_acl, remaining_default_acl;
    END IF;

    RAISE NOTICE 'verified: no direct or default ACL entries remain for anonymous/authenticated';
END
$verify$;

COMMIT;
