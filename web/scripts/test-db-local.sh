#!/usr/bin/env bash
# Run the pgTAP suite against the LOCAL throwaway database.
#
#   web/scripts/test-db-local.sh          # from the repo root, in Git Bash
#
# This is the same test-db.sh CI runs, with two differences that are both about
# the machine rather than the tests:
#
#   * `psql` resolves to scripts/psql-shim.js (see local-db-setup.ps1 for why a
#     client has to be synthesised on Windows);
#   * it RECREATES the database first. test-db.sh deliberately refuses to run
#     against a non-empty one, because applying 000..024 to a database that
#     already has them is exactly the half-applied state the migrations are
#     written to be re-runnable through - and a gate that quietly runs against
#     yesterday's schema is worse than no gate.
#
# Usage: run local-db-setup.ps1 once first (npm run db:local).
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

# The shim must be on PATH BEFORE the first psql call below, not just before
# test-db.sh. Recreate-first-then-export put the recreate itself outside the PATH
# and it failed with `psql: command not found` - which only appears once the
# suite is run the packaged way rather than with the shim exported by hand.
export PATH="$ROOT/$SHIM_DIR:$PATH"

# Recreate. Both statements are separate because a multi-statement query runs
# inside one implicit transaction, and DROP DATABASE cannot run in one.
ADMIN_URL="${DATABASE_URL/lensy/postgres}"
psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 \
  -c 'drop database if exists lensy' \
  -c 'create database lensy'

exec bash web/scripts/test-db.sh
