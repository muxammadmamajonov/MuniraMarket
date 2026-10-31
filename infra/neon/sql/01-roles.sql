-- Least-privilege roles for one MuniraMarket database (one Neon branch per environment).
--
-- Run ONCE per environment as the Neon project owner role (the Console-created role, which is a
-- member of neon_superuser and is kept for break-glass use only):
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v migrator_password="$MIGRATOR_PASSWORD" -v app_password="$APP_PASSWORD" \
--     -f infra/neon/sql/01-roles.sql
--
-- Roles are created with SQL on purpose: Console/API-created roles join neon_superuser, SQL roles
-- do not. Passwords come from psql variables (generate 32+ random characters each, store them
-- only in the secret manager / Worker secrets). Idempotent: re-running rotates nothing unless
-- you pass new passwords, in which case it sets them.

\set ON_ERROR_STOP on

-- mm_migrator: owns the schema objects; used only by the one-off migration job.
SELECT format('CREATE ROLE mm_migrator LOGIN PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mm_migrator') \gexec
SELECT format('ALTER ROLE mm_migrator LOGIN PASSWORD %L', :'migrator_password') \gexec
ALTER ROLE mm_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3;

-- mm_app: the runtime role of the Core API. DML only, never DDL, never owner.
SELECT format('CREATE ROLE mm_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mm_app') \gexec
SELECT format('ALTER ROLE mm_app LOGIN PASSWORD %L', :'app_password') \gexec
-- Connection cap: instances x (DB_POOL_SIZE + DB_MAX_OVERFLOW) = 3 x 10 = 30, plus headroom for
-- a rollout where old and new instances overlap.
ALTER ROLE mm_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 60;
-- Server-side guards even if a client forgets them (the API also sets these per session).
ALTER ROLE mm_app SET statement_timeout = '15s';
ALTER ROLE mm_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE mm_app SET lock_timeout = '5s';
