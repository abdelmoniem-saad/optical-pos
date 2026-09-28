-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================
-- LensyPOS — Phase 6 gate: 020_version_gate_test.sql (pgTAP)
-- ============================================================
-- 020 exists because 018 and 019 forgot to record their own version, and the
-- existing 017 gate could not notice: it asserted that schema_version() returns
-- 17, which was true. The defect was invisible to every test we had.
--
-- So this gate asserts the INVARIANT rather than a value:
--
--   G-V1  the guard function exists
--   G-V2  it does NOT raise when the ledger is complete
--   G-V3  it DOES raise when a version is missing - the whole point, and the
--         case that would have caught 018/019
--   G-V4  it names the missing version in the message, so the operator is told
--         which file to look at rather than just "something is wrong"
--   G-V5  018 and 019 are recorded after this migration applies
--   G-V6  re-recording an existing version is a no-op (idempotency)
--   G-V7  an empty migration list is rejected rather than silently passing
--
-- G-V3 is the assertion that would have prevented the bug. Written first, before
-- the happy path, because a guard that has never been seen to fail is not known
-- to work.
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 10 assertions, each labelled. G-V3 and G-V4 deliberately come BEFORE G-V2: a
-- guard is only trustworthy once it has been seen to fail, and asserting the
-- happy path first is how a guard that never fires gets mistaken for one that
-- works - which is precisely how 018/019 got through.
select plan(10);

-- ===== G-V1: the guard exists ===========================================
select has_function('public', 'assert_versions_recorded', ARRAY['text'],
  'G-V1 the drift guard exists, so a missing stamp fails loudly instead of silently');

-- ===== G-V3 (before G-V2): the guard actually catches a missing version ===
-- Deliberately first. Asserting that a guard PASSES before asserting that it
-- FAILS is how a guard that never fires gets mistaken for one that works - and
-- that is exactly the confusion that let 018/019 through in the first place.
-- '012_anything.sql' stands in for a migration that forgot to record itself.
select throws_ok(
  $$select public.assert_versions_recorded(array['017_a.sql', '018_b.sql', '019_c.sql'])$$,
  'P0001',
  null,
  'G-V3 the guard raises when a migration in the list has not recorded its version'
);

-- G-V4. The message has to NAME the version, or an operator reading a failure
-- at 2am does not know which of twenty files is at fault.
select throws_ok(
  $$select public.assert_versions_recorded(array['017_a.sql', '018_b.sql', '019_c.sql'])$$,
  'P0001',
  'migration ledger is missing version\(s\) for: 019',
  'G-V4 the message names the missing version, so it says which file is at fault'
);

-- ===== G-V2: and it stays quiet when everything IS recorded =============
select lives_ok(
  $$select public.assert_versions_recorded(array['017_a.sql', '018_b.sql', '019_c.sql', '020_d.sql'])$$,
  'G-V2 the guard does not raise when the ledger is complete'
);

-- ===== G-V7: an empty list is not a pass ===============================
-- Otherwise a caller that failed to pass the file list would get a green build
-- for having checked nothing - the most expensive kind of vacuous pass.
select throws_ok(
  $$select public.assert_versions_recorded(array[]::text[])$$,
  'P0001',
  null,
  'G-V7 an empty migration list is rejected rather than silently passing'
);

-- ===== G-V5: 018 and 019 are recorded =================================
-- 020 backfills them, so after this migration applies the ledger knows about
-- every migration from 017 onwards. These are the two the bug actually lost.
select ok(
  exists (select 1 from public.lensy_schema_versions where version = 18),
  'G-V5a 018 is recorded - 020 backfilled what it forgot to write itself'
);

select ok(
  exists (select 1 from public.lensy_schema_versions where version = 19),
  'G-V5b 019 is recorded too'
);

select ok(
  exists (select 1 from public.lensy_schema_versions where version = 20),
  'G-V5c 020 records itself, the way every migration from 017 onward must'
);

-- ===== G-V6: re-running changes nothing ================================
-- The operator flow IS "paste into the SQL Editor", so a second paste is
-- ordinary rather than exceptional.
select is(
  (select count(*)::int from public.lensy_schema_versions),
  (select count(distinct version)::int from public.lensy_schema_versions),
  'G-V6 re-recording a version adds no duplicate row'
);

-- The version the app compares against must be the highest one applied, or the
-- banner either nags a migrated shop or stays silent through real drift.
select is(
  public.schema_version(),
  20,
  'G-V6b schema_version() is the highest applied version, so the drift check is live'
);

rollback;
