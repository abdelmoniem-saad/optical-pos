#!/usr/bin/env bash
# Apply every migration from scratch to a THROWAWAY database and run all the
# pgTAP gates (web/supabase/tests/*_test.sql).
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

echo "== 2/3 migrations (database must be empty)"
for f in web/supabase/[0-9][0-9][0-9]_*.sql; do
  echo "     - $(basename "$f")"
  if ! "${PSQL[@]}" -f "$f"; then
    echo "FAIL: migration $(basename "$f") did not apply - see psql error above" >&2
    exit 1
  fi
done

echo "== 3/3 pgTAP gates"
# Every tests/*_test.sql is a gate. Each one is a self-contained transaction that
# rolls back, so they can share one throwaway database; a new phase just drops
# its own file in and is picked up here with no change to this runner.
failed=0
for t in web/supabase/tests/*_test.sql; do
  echo "--- $(basename "$t")"
  set +e
  out="$("${PSQL[@]}" -tA -f "$t" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$out"

  if [ "$status" -ne 0 ]; then
    echo "FAIL: psql exited $status while running $(basename "$t")" >&2
    failed=1
    continue
  fi
  if printf '%s\n' "$out" | grep -qE '^not ok'; then
    echo "FAIL: $(basename "$t") has at least one failing assertion" >&2
    failed=1
    continue
  fi
  if ! printf '%s\n' "$out" | grep -qE '^1\.\.[0-9]'; then
    echo "FAIL: no TAP plan in $(basename "$t") - the test file did not run" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "FAIL: one or more pgTAP gates are red" >&2
  exit 1
fi
echo "PASS: all pgTAP assertions green"
