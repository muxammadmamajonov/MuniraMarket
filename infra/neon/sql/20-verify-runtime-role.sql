-- Fails (non-zero exit with ON_ERROR_STOP) unless the runtime role has exactly the intended
-- privileges. Run after 10-runtime-grants.sql, in CI and after every production migration.
--
--   psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/20-verify-runtime-role.sql

\set ON_ERROR_STOP on

DO $$
DECLARE
  problems text[] := '{}';
  t record;
BEGIN
  -- audit_log: SELECT and INSERT only.
  IF NOT has_table_privilege('mm_app', 'public.audit_log', 'INSERT') THEN
    problems := problems || 'mm_app cannot INSERT into audit_log';
  END IF;
  IF NOT has_table_privilege('mm_app', 'public.audit_log', 'SELECT') THEN
    problems := problems || 'mm_app cannot SELECT from audit_log';
  END IF;
  IF has_table_privilege('mm_app', 'public.audit_log', 'UPDATE')
     OR has_table_privilege('mm_app', 'public.audit_log', 'DELETE')
     OR has_table_privilege('mm_app', 'public.audit_log', 'TRUNCATE') THEN
    problems := problems || 'mm_app may UPDATE, DELETE or TRUNCATE audit_log';
  END IF;

  -- No table is owned by, or truncatable by, the runtime role.
  FOR t IN
    SELECT c.oid::regclass AS rel, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    IF t.owner = 'mm_app' THEN
      problems := problems || format('%s is owned by mm_app', t.rel);
    END IF;
    IF has_table_privilege('mm_app', t.rel, 'TRUNCATE') THEN
      problems := problems || format('mm_app may TRUNCATE %s', t.rel);
    END IF;
  END LOOP;

  -- No DDL: the runtime role cannot create objects in the schema.
  IF has_schema_privilege('mm_app', 'public', 'CREATE') THEN
    problems := problems || 'mm_app may CREATE in schema public';
  END IF;

  -- Role attributes.
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'mm_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    problems := problems || 'mm_app has elevated role attributes';
  END IF;
  IF pg_has_role('mm_app', 'mm_migrator', 'MEMBER') THEN
    problems := problems || 'mm_app is a member of mm_migrator';
  END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'runtime role check failed: %', array_to_string(problems, '; ');
  END IF;
  RAISE NOTICE 'runtime role check passed';
END
$$;
