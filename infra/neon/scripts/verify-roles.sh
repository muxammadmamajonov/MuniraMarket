#!/usr/bin/env bash
# End-to-end check of the Neon role model against a DISPOSABLE PostgreSQL (CI or a local Docker
# container), never against Neon:
#
#   1. create a scratch database and run 01-roles.sql / 02-database.sql as a superuser
#      (standing in for the Neon owner role);
#   2. run the real Alembic migrations as mm_migrator (MIGRATION_DATABASE_URL);
#   3. apply 10-runtime-grants.sql and 20-verify-runtime-role.sql as mm_migrator;
#   4. as mm_app: INSERT/SELECT audit_log must work; UPDATE/DELETE/TRUNCATE on audit_log, DDL
#      and reading alembic_version must be refused.
#
# Usage: ADMIN_URL=postgresql://user:pass@localhost:5432/postgres infra/neon/scripts/verify-roles.sh
# Passwords are generated per run and never printed.
set -euo pipefail

: "${ADMIN_URL:?ADMIN_URL (superuser libpq URL of a disposable PostgreSQL) is required}"
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
db="mm_roles_check_$RANDOM"
migrator_pw="$(openssl rand -hex 24)"
app_pw="$(openssl rand -hex 24)"

# libpq URL of the same server for another user/database.
url_for() { # user password database
  python3 - "$ADMIN_URL" "$1" "$2" "$3" <<'PY'
import sys
from urllib.parse import quote, urlsplit, urlunsplit
base, user, password, database = sys.argv[1:]
parts = urlsplit(base)
host = parts.hostname + (f":{parts.port}" if parts.port else "")
print(urlunsplit((parts.scheme, f"{quote(user)}:{quote(password)}@{host}", f"/{database}", "", "")))
PY
}
admin_db_url="$(python3 - "$ADMIN_URL" "$db" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
parts = urlsplit(sys.argv[1])
print(urlunsplit((parts.scheme, parts.netloc, f"/{sys.argv[2]}", parts.query, "")))
PY
)"
migrator_url="$(url_for mm_migrator "$migrator_pw" "$db")"
app_url="$(url_for mm_app "$app_pw" "$db")"

cleanup() {
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" \
    -c "DROP ROLE IF EXISTS mm_app" -c "DROP ROLE IF EXISTS mm_migrator" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db"
psql "$admin_db_url" -q -v ON_ERROR_STOP=1 \
  -v migrator_password="$migrator_pw" -v app_password="$app_pw" -f "$here/sql/01-roles.sql"
psql "$admin_db_url" -q -v ON_ERROR_STOP=1 -f "$here/sql/02-database.sql"

echo "migrating as mm_migrator"
(
  cd "$repo/services/api"
  APP_ENV=development \
    MIGRATION_DATABASE_URL="${migrator_url/postgresql:/postgresql+asyncpg:}" \
    uv run alembic upgrade head >/dev/null
)

psql "$migrator_url" -q -v ON_ERROR_STOP=1 -f "$here/sql/10-runtime-grants.sql"
psql "$migrator_url" -q -v ON_ERROR_STOP=1 -f "$here/sql/20-verify-runtime-role.sql"

as_app() { psql "$app_url" -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }
must_fail() { # description sql
  if as_app "$2" >/dev/null 2>&1; then
    echo "FAIL: mm_app was allowed to $1" >&2
    exit 1
  fi
  echo "ok: mm_app cannot $1"
}

as_app "INSERT INTO audit_log (id, actor_role, action, entity_type, entity_id, details)
        VALUES (gen_random_uuid(), 'admin', 'roles.check', 'check', 'ci', '{}'::jsonb)"
test "$(as_app "SELECT count(*) FROM audit_log WHERE action = 'roles.check'")" = "1"
echo "ok: mm_app can INSERT and SELECT audit_log"
as_app "SELECT count(*) FROM products" >/dev/null
echo "ok: mm_app can read application tables"

must_fail "UPDATE audit_log" "UPDATE audit_log SET action = 'x'"
must_fail "DELETE from audit_log" "DELETE FROM audit_log"
must_fail "TRUNCATE audit_log" "TRUNCATE audit_log"
must_fail "TRUNCATE products" "TRUNCATE products CASCADE"
must_fail "CREATE TABLE" "CREATE TABLE intruder (id int)"
must_fail "ALTER TABLE" "ALTER TABLE products ADD COLUMN intruder int"
must_fail "DROP TRIGGER" "DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log"
must_fail "read alembic_version" "SELECT * FROM alembic_version"

# A table created by a later migration is read/insert only until the grants are re-applied.
psql "$migrator_url" -q -v ON_ERROR_STOP=1 -c "CREATE TABLE future_table (id int)"
must_fail "UPDATE a new table before the grants run" "UPDATE future_table SET id = 1"
psql "$migrator_url" -q -v ON_ERROR_STOP=1 -f "$here/sql/10-runtime-grants.sql"
as_app "UPDATE future_table SET id = 1" >/dev/null
echo "ok: grants re-applied after a migration open DML on the new table"
echo "role model verified"
