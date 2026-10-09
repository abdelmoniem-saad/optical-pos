#!/usr/bin/env bash
# Measure the report functions at ~50k-row scale on the LOCAL database.
#
#   bash web/scripts/bench-queries.sh          # from the repo root, in Git Bash
#
# Recreates the local `lensy` database, applies the shim + every migration,
# seeds 50k sales (supabase/bench/seed_50k.sql), then runs EXPLAIN (ANALYZE,
# BUFFERS) over the report functions (supabase/bench/bench_queries.sql).
#
# This is NOT a CI gate and never should be: the timings are for a human to
# read and act on. Wall-clock assertions in CI are flaky and a permanently-red
# build trains people to ignore the one that matters. The shim + migrations are
# the same ones test-db.sh applies, so the measured schema is the real schema.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOCAL_DIR="web/.local-db"
SHIM_DIR="$LOCAL_DIR/shim"
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/lensy}"

if [ ! -d "$SHIM_DIR" ]; then
  echo "No local database found. Run this once first:" >&2
  echo "    npm run db:local" >&2
  exit 1
fi

# The shim must be on PATH before the first psql call, or it is `command not
# found` (test-db-local.sh records this trap).
export PATH="$ROOT/$SHIM_DIR:$PATH"
ADMIN_URL="${DATABASE_URL/lensy/postgres}"

echo "== recreate the throwaway database"
psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 \
  -c 'drop database if exists lensy' \
  -c 'create database lensy'

echo "== apply harness shim + migrations 000..latest"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f web/supabase/tests/_shim.sql
for f in web/supabase/[0-9][0-9][0-9]_*.sql; do
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$f"
done

echo "== seed 50k sales (supabase/bench/seed_50k.sql)"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f web/supabase/bench/seed_50k.sql

echo "== benchmark the report functions (supabase/bench/bench_queries.sql)"
# Not -q here: the EXPLAIN plans ARE the output.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f web/supabase/bench/bench_queries.sql
