-- Runtime grants, re-applied after EVERY migration by the migration job (idempotent).
--
--   psql "$MIGRATOR_URL" -v ON_ERROR_STOP=1 -f infra/neon/sql/10-runtime-grants.sql
--
-- Runs as mm_migrator, the owner of every table, so it can grant and revoke on them.

\set ON_ERROR_STOP on

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mm_app;

-- Alembic's bookkeeping is the migrator's alone.
REVOKE ALL ON TABLE public.alembic_version FROM mm_app;

-- The audit log is append-only for the application (ADR 0010): it may write and read entries,
-- never change or remove them. The table's triggers also reject UPDATE/DELETE/TRUNCATE, but they
-- do not stop the table owner; this keeps the runtime role from ever being that owner.
REVOKE ALL ON TABLE public.audit_log FROM mm_app;
GRANT SELECT, INSERT ON TABLE public.audit_log TO mm_app;

-- Never let the runtime role own anything or truncate anything.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM mm_app;

COMMIT;
