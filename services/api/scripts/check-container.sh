#!/usr/bin/env bash
# Startup checks of the Core API image (CI): fail closed on insecure config, serve health, stop
# cleanly on SIGTERM, JSON logs without secrets. Every value below is a throw-away CI placeholder.
# Usage: services/api/scripts/check-container.sh <image> [host port]
set -euo pipefail
image="${1:?image}"
port="${2:-18000}"
common=(
  -e TELEGRAM_BOT_ID=123456789
  -e SERVICE_AUTH_KEYS=ci:ci-only-service-key-not-a-secret-000000
  -e CSRF_TRUSTED_ORIGINS=https://shop.example.test,https://admin.example.test
  -e FORWARDED_ALLOW_IPS=10.0.0.0/8
  -e REDIS_URL=rediss://:ci-redis-pw@redis.example.test:6380/0
  -e DB_CONNECT_TIMEOUT_SECONDS=2
)
log="$(mktemp)"

echo "1. a production container without TLS to PostgreSQL refuses to start"
if docker run --rm -e APP_ENV=production \
  -e DATABASE_URL=postgresql+asyncpg://app:ci-db-pw@db.example.test/app "${common[@]}" \
  "$image" >"$log" 2>&1; then
  echo "container started with an insecure DATABASE_URL" >&2; exit 1
fi
grep -q "DATABASE_URL must set ssl=require" "$log" || { cat "$log" >&2; exit 1; }
if grep -q "ci-db-pw" "$log"; then echo "startup error leaked the DB password" >&2; exit 1; fi

echo "2. a valid production config serves liveness, reports readiness honestly, logs JSON"
cid="$(docker run -d -p "127.0.0.1:${port}:8000" -e APP_ENV=production \
  -e "DATABASE_URL=postgresql+asyncpg://app:ci-db-pw@db.example.test/app?ssl=require" \
  "${common[@]}" "$image")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${port}/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
headers="$(curl -fsS -D - -o /dev/null -H 'X-Request-ID: ci-health-check-01' \
  "http://127.0.0.1:${port}/api/v1/health")"
grep -qi '^x-request-id: ci-health-check-01' <<<"$headers" || { echo "$headers" >&2; exit 1; }
if grep -qi '^server:' <<<"$headers"; then echo "Server header is sent" >&2; exit 1; fi
ready="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/v1/health/ready")"
[ "$ready" = "503" ] || { echo "readiness without a database returned $ready" >&2; exit 1; }
docs="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/v1/openapi.json")"
[ "$docs" = "404" ] || { echo "OpenAPI is exposed in production ($docs)" >&2; exit 1; }

echo "3. SIGTERM stops it gracefully"
docker stop -t 30 "$cid" >/dev/null
code="$(docker wait "$cid")"
docker logs "$cid" >"$log" 2>&1
[ "$code" = "0" ] || { tail -20 "$log" >&2; echo "exit code $code" >&2; exit 1; }
grep -q '"msg": "core-api stopping"' "$log" || { tail -20 "$log" >&2; exit 1; }
python3 - "$log" <<'PY'
import json, sys
lines = [l for l in open(sys.argv[1]) if l.startswith("{")]
assert lines, "no JSON log lines"
for line in lines:
    entry = json.loads(line)
    assert {"ts", "level", "logger", "msg", "env"} <= entry.keys(), entry
PY
if grep -q "ci-db-pw\|ci-redis-pw\|ci-only-service-key" "$log"; then
  echo "logs contain a secret" >&2; exit 1
fi
echo "container checks passed"
