#!/usr/bin/env bash
# Every migration from 017 onward must record its own version, or the drift
# check silently stops working.
#
# WHY THIS EXISTS
# ---------------
# 017 introduced `record_schema_version()` so the database could report which
# migrations it had absorbed, and 017 recorded itself. 018 and 019 did not. A shop
# that had applied every migration in this repository therefore answered the same
# version as a shop that had stopped at 017, so the app's comparison could never
# fail. The 017 gate did not catch it either: it asserted `schema_version()` returns
# 17, which was true. The drift check - the one thing Phase 5 built so that a
# mismatch could never pass unnoticed - was itself the blind spot.
#
# It surfaced only because a shop upgraded and then asked why the number had not
# moved. That is exactly the kind of defect no assertion catches, because every
# individual value was correct.
#
# So the rule is enforced here instead: a migration that forgets to stamp itself
# is a RED BUILD at review time, not a question asked months later. The SQL side
# (assert_versions_recorded, migration 020) checks the ledger against the applied
# migrations; this script checks the FILES, which is the half the database cannot
# see - a database knows what it ran, not what exists.
#
# Run: bash web/scripts/check-migrations-stamp.sh
# Exits non-zero on the first migration from 017 that does not stamp itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The first migration that participates in the version ledger. Everything before
# it predates the mechanism and cannot be expected to stamp itself.
FIRST_VERSIONED=17

missing=""
# Migrations that predate the rule and are already applied to a live shop. They
# CANNOT be edited (the repository rule: never edit an applied migration), so they
# are grandfathered explicitly here rather than silently grandfathered by the
# comparison below. 020 backfills the ledger for both, so a shop is unaffected by
# their omission.
GRANDFATHERED=" 018_purchase_stock.sql 019_lab_dwell.sql "

for f in web/supabase/[0-9][0-9][0-9]_*.sql; do
  name="$(basename "$f")"
  num="${name:0:3}"
  # Leading zeros make arithmetic comparison useless, so strip them.
  num_int=$((10#$num))

  if [ "$num_int" -lt "$FIRST_VERSIONED" ]; then
    continue
  fi

  case " $GRANDFATHERED " in
    *" $name "*) continue ;;
  esac

  # A comment mentioning the function is not the same as calling it, so the
  # pattern is anchored to a statement start. The trailing ';' requirement means
  # a passing mention in prose cannot satisfy this.
  if ! grep -Eq '^[[:space:]]*select[[:space:]]+public\.record_schema_version\(' "$f"; then
    missing="$missing $name"
  fi
done

if [ -n "$missing" ]; then
  echo "FAIL: these migrations do not record their own version:" >&2
  for m in $missing; do
    echo "  $m" >&2
    # The suggestion is printed without the surrounding SQL string quotes.
    # Nesting a literal ' inside a double-quoted string ends the quoting early,
    # and the shell then tries to parse the remainder as code - a syntax error
    # in the error message, which is the worst possible place for one.
    # ${m:0:3} keeps the leading zero so the number matches the filename, which
    # is what the operator is looking at. (record_schema_version takes an int, and
    # '021' and 21 are the same value to Postgres, so the leading zero is
    # cosmetic - and matching the filename is worth more than looking tidy.)
    echo "    add:  select public.record_schema_version(${m:0:3}, 'what it does');" >&2
  done
  echo >&2
  echo "Without it, schema_version() keeps reporting the last migration that DID" >&2
  echo "stamp, so the drift check cannot detect a shop that never applied these." >&2
  exit 1
fi

echo "PASS: every migration from ${FIRST_VERSIONED} onward records its own version"
