#!/usr/bin/env bash
# Print a stable fingerprint of the PUBLIC schema: the shape of the database
# after every migration has been applied, hashed.
#
#   DATABASE_URL=postgresql://... bash web/scripts/schema-fingerprint.sh
#
# Why this exists
# ---------------
# The migrations in web/supabase/ are applied BY HAND. That is fine, and it is
# the reason this repo has no migration ledger: nothing enforces that a shop's
# database matches the files in front of you. The cost is that "the code and
# the database have drifted" is invisible until a query fails at runtime, in
# front of a customer, with a stack trace instead of an explanation.
#
# So the schema gets a checksum. If the number changes, a migration changed the
# shape of the database; if it does not, the migrations did nothing. Comparing
# it in CI against web/supabase/schema.fingerprint turns drift from something
# you discover into something you see.
#
# Why not `supabase gen types`
# ----------------------------
# That needs either a live project id + access token, or `supabase db start`
# (the whole Supabase container stack). This repo's CI database is plain
# Postgres 16 built by web/scripts/test-db.sh, not a Supabase instance, and
# `gen types --db-url` is unusable for exactly that case - it requires Docker
# Desktop and supabase/cli#2536 was closed as "not planned". So the fingerprint
# replaces it: it needs only psql, it covers the whole public schema rather
# than the subset TypeScript happens to import, and it cannot leak credentials
# because it never connects to anything the tests do not already use.
#
# Comments are stripped (--no-comments) on purpose: the explanatory comments in
# these migrations change often and mean nothing to the database. A fingerprint
# that moved on every comment edit would be ignored, and an ignored signal is
# worse than none.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/lensy}"

# pg_dump is not part of postgresql-client's default install on the runner, so
# report the missing tool clearly instead of letting it fail as "command not
# found" three lines later.
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "schema-fingerprint: pg_dump is required (apt-get install postgresql-client-16)" >&2
  exit 1
fi

# --schema-only: no data, just the shape. --no-comments: see above.
# Normalised whitespace (sed) so a re-indent or a trailing-space change in a
# migration file is not reported as a schema change.
pg_dump "$DB_URL" \
  --schema-only \
  --no-comments \
  --no-owner \
  --no-privileges \
  | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//' \
  | grep -v '^$' \
  | sha256sum \
  | cut -d' ' -f1
