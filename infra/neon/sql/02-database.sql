-- Database and schema privileges. Run ONCE per environment as the Neon owner role, after
-- 01-roles.sql, connected to the application database:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/02-database.sql

\set ON_ERROR_STOP on

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

-- Tables the migrator creates later are usable by the runtime role (DML only). audit_log is
-- narrowed again by 10-runtime-grants.sql after every migration.
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mm_app;
