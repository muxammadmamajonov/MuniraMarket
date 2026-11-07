-- Default privileges for objects future migrations create in `public`.
--
-- Run once per environment as mm_migrator, after 02-database.sql and before
-- the first Alembic migration:
--
--   psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 \
--     -f infra/neon/sql/03-default-privileges.sql
--
-- Running as the object-creating role is deliberate: it needs no temporary
-- membership grant to the Neon owner, so the owner never gains migration-role
-- privileges. Re-running is idempotent.

\set ON_ERROR_STOP on

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO mm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mm_app;
