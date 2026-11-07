-- Database and schema privileges. Run ONCE per environment as the Neon owner role, after
-- 01-roles.sql, connected to the application database:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/02-database.sql

\set ON_ERROR_STOP on

BEGIN;

-- `ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator` requires the operator to be
-- a member of mm_migrator. A Neon project owner creates that role but is not
-- automatically its member. Grant only for this transaction and record whether
-- it existed beforehand, so a failed bootstrap rolls everything back and a
-- pre-existing membership is never changed.
DO $$
BEGIN
  IF pg_has_role(current_user, 'mm_migrator', 'MEMBER') THEN
    PERFORM set_config('muniramarket.owner_was_migrator_member', 'true', true);
  ELSE
    EXECUTE format('GRANT %I TO %I', 'mm_migrator', current_user);
    PERFORM set_config('muniramarket.owner_was_migrator_member', 'false', true);
  END IF;
END
$$;

-- Nobody connects unless granted.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO mm_migrator', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO mm_app', current_database()) \gexec

-- The migrator creates and owns the application's tables in "public"; the runtime role may only
-- use the schema. (PostgreSQL 15+ no longer grants CREATE on public to PUBLIC; revoke anyway.)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO mm_migrator;
GRANT USAGE ON SCHEMA public TO mm_app;

-- Migration 0002 needs pg_trgm. Creating an extension needs more than the migrator has, so the
-- owner installs it once; the migration's CREATE EXTENSION IF NOT EXISTS is then a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tables the migrator creates later start with SELECT and INSERT only (so a new append-only
-- table is never briefly mutable); 10-runtime-grants.sql, run after every migration, adds
-- UPDATE/DELETE to every table except audit_log. Until then a new table is read/insert only:
-- the application fails closed rather than gaining rights early.
SET LOCAL ROLE mm_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO mm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mm_app;
RESET ROLE;

DO $$
BEGIN
  IF current_setting('muniramarket.owner_was_migrator_member', true) = 'false' THEN
    EXECUTE format('REVOKE %I FROM %I', 'mm_migrator', current_user);
  END IF;
END
$$;

COMMIT;
