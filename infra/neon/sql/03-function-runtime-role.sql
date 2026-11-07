-- Least privilege for the Core API Neon Function (ADR 0016). Run ONCE per environment, as the
-- project owner, after 01-roles.sql:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v function_role="<role of the injected DATABASE_URL>" \
--     -f infra/neon/sql/03-function-runtime-role.sql
--
-- Neon injects DATABASE_URL into Functions with the branch's default role. The Function runs
-- every transaction as `SET LOCAL ROLE mm_app` (DB_RUNTIME_ROLE=mm_app), which needs membership
-- in mm_app. Membership is NOINHERIT-safe: without SET ROLE the default role's own rights apply,
-- so this grant adds no right to the default role; it only lets it step DOWN to mm_app.
\set ON_ERROR_STOP on

SELECT format('GRANT mm_app TO %I', :'function_role') \gexec
SELECT set_config('mm.function_role', :'function_role', false);

-- Fail loudly if the membership did not take.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid AND granted.rolname = 'mm_app'
    JOIN pg_roles member ON member.oid = m.member AND member.rolname = current_setting('mm.function_role')
  ) THEN
    RAISE EXCEPTION 'mm_app membership missing';
  END IF;
END $$;
