#!/usr/bin/env bash
# Safely run the one-time adoption of objects created before mm_migrator existed.
# The caller supplies OWNER_URL (without a password is fine: libpq reads PGPASSWORD).
set -euo pipefail

: "${OWNER_URL:?OWNER_URL is required}"
here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/../sql/00-adopt-legacy-public-schema.sql"

owner_can_set_role="$(psql "$OWNER_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT pg_has_role(current_user, 'mm_migrator', 'SET')")"
added_membership=0

cleanup() {
  if [ "$added_membership" -eq 1 ]; then
    psql "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 -c \
      "DO \$\$ BEGIN EXECUTE format('REVOKE %I FROM %I', 'mm_migrator', current_user); END \$\$;" \
      >/dev/null || echo 'WARNING: could not revoke temporary mm_migrator membership' >&2
  fi
}
trap cleanup EXIT

if [ "$owner_can_set_role" = "f" ]; then
  psql "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 -c \
    "DO \$\$ BEGIN EXECUTE format('GRANT %I TO %I', 'mm_migrator', current_user); END \$\$;" \
    >/dev/null
  added_membership=1
elif [ "$owner_can_set_role" != "t" ]; then
  echo 'could not determine whether the owner can SET ROLE mm_migrator' >&2
  exit 1
fi

psql "$OWNER_URL" -X -v ON_ERROR_STOP=1 -f "$sql"
cleanup
trap - EXIT
