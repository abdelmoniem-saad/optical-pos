#!/usr/bin/env bash
# Apply 000…012 from scratch to a THROWAWAY database and run the pgTAP gate
# (web/supabase/tests/012_integrity_test.sql).
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lensy \
#     bash web/scripts/test-db.sh
#
# The database must be EMPTY and must be able to `create extension pgtap`
# (CI installs postgresql-16-pgtap inside the postgres:16 container; a
# Supabase project can create it directly).
#
# Non-zero exit on any migration failure or any failing TAP assertion.
# No pg_prove/perl dependency: the TAP stream printed by psql is parsed here,
# so the runner only needs `psql` (postgresql-client).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/lensy}"
PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1)

echo "== 1/3 harness shims (plain-Postgres objects: roles, auth/, storage/, pgtap)"
if ! "${PSQL[@]}" -f web/supabase/tests/_shim.sql; then
  echo "FAIL: harness shims (_shim.sql) did not apply - see psql error above" >&2
  exit 1
fi

echo "== 2/3 migrations 000 -> 012 (database must be empty)"
for f in web/supabase/[0-9][0-9][0-9]_*.sql; do
  echo "     - $(basename "$f")"
  if ! "${PSQL[@]}" -f "$f"; then
    echo "FAIL: migration $(basename "$f") did not apply - see psql error above" >&2
    exit 1
  fi
done

echo "== 3/3 pgTAP gate"
set +e
out="$("${PSQL[@]}" -tA -f web/supabase/tests/012_integrity_test.sql 2>&1)"
status=$?
set -e
printf '%s\n' "$out"

if [ "$status" -ne 0 ]; then
  echo "FAIL: psql exited $status while running the test file" >&2
  exit 1
fi
if printf '%s\n' "$out" | grep -qE '^not ok'; then
  echo "FAIL: at least one pgTAP assertion failed" >&2
  exit 1
fi
if ! printf '%s\n' "$out" | grep -qE '^1\.\.[0-9]'; then
  echo "FAIL: no TAP plan found - the test file did not run" >&2
  exit 1
fi
echo "PASS: all pgTAP assertions green"
