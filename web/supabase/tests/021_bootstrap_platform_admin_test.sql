-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 6 gate: 021_bootstrap_platform_admin_test.sql (pgTAP)
-- ============================================================
-- platform_admins is the one table whose contents bypass every other policy, so
-- it is right that nothing can write to it. But 008 seeded it during migration
-- time and then closed the only window, which left a locked table with no key:
-- the SQL Editor, the Table Editor and CREATE POLICY each refuse. This gate
-- covers the key that replaced that, and - the half that actually protects
-- anyone - proves it is a key that opens the door exactly ONCE:
--
--   G0     the table really is empty to begin with, so G8 is not vacuous
--   G1/G2  an email with no login is refused, and says so
--   G3     a blank email is refused
--   G4     the FIRST call creates the platform admin
--   G5     it reports the uid it granted
--   G6/G7  it also creates the staff row the browser can never write, store-less
--   G8     a SECOND call is REFUSED - the whole security property
--   G9     the refusal left exactly one admin, so it changed nothing
--   G10    a client cannot call it at all
--   G11    021 stamped itself
--
-- G1-G3 run BEFORE G4 on purpose. The guard checks the admin count first, so
-- once one exists every later call reports "already exists" and the argument
-- checks would be unreachable - a test that only passes in the order it was
-- written is a test that stops testing the moment it is reordered.
--
-- Everything runs inside ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(12);

-- ===== G0: the control =====================================================
-- 008 seeds a platform admin only for a staff row named 'superadmin'; the
-- seeded database has none, but this asserts it rather than assuming, because
-- every assertion below about the guard is meaningless if a row is already here.
delete from public.platform_admins;

select is((select count(*)::int from public.platform_admins), 0,
  'G0 no platform admin exists yet, so the guard has something to protect');

-- A login that exists and is not a platform admin. The email local part is the
-- username, exactly as ensureStaffRecord() derives it in auth.tsx.
insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-0000000000b1', 'vendor@lensypos.local', 'vendor')
on conflict (id) do nothing;

-- ===== G1/G2: the argument checks, while the guard is still open ==========
select throws_ok(
  $$select public.bootstrap_platform_admin('nobody@lensypos.local')$$,
  'P0001',
  null,
  'G1 an email with no Supabase login is refused - it grants a role, it does not create a credential'
);

select throws_ok(
  $$select public.bootstrap_platform_admin('nobody@lensypos.local')$$,
  'P0001',
  'bootstrap_platform_admin: no Supabase Auth login with the email nobody@lensypos.local - create the user in the dashboard first, then run this',
  'G2 and the message names the address that was not found'
);

select throws_ok(
  $$select public.bootstrap_platform_admin('   ')$$,
  'P0001',
  null,
  'G3 a blank email is refused rather than matching every login'
);

-- ===== G4/G5: the one legitimate call =====================================
select is(
  (select count(*)::int from public.platform_admins
    where auth_uid = 'eeeeeeee-eeee-4eee-8eee-0000000000b1'),
  1,
  'G4 the first call creates the platform admin'
);

select is(
  (select p.auth_uid::text from public.platform_admins p
    where p.auth_uid = 'eeeeeeee-eeee-4eee-8eee-0000000000b1'),
  'eeeeeeee-eeee-4eee-8eee-0000000000b1',
  'G5 and it reports the uid it granted, so the caller can see what happened'
);

-- ===== G6/G7: the staff row the browser cannot write =======================
-- The INSERT policy on public.users requires a store or platform admin, so a
-- first-time login's own attempt is always refused. This is that row, written
-- by the definer instead - and it is the reason a fresh account used to end up
-- told it was "not linked to a store" with a database that was entirely correct.
select is(
  (select count(*)::int from public.users
    where id = 'eeeeeeee-eeee-4eee-8eee-0000000000b1'
      and username = 'vendor'),
  1,
  'G6 the staff row is created too, keyed by the auth uid'
);

select is(
  (select store_id::text from public.users
    where id = 'eeeeeeee-eeee-4eee-8eee-0000000000b1'),
  null,
  'G7 and it is store-less on purpose - a vendor belongs to no shop, and that is what lets platform admin rather than a store decide what they see'
);

-- ===== G8/G9: the guard - the assertion that matters ========================
select throws_ok(
  $$select public.bootstrap_platform_admin('vendor@lensypos.local')$$,
  'P0001',
  null,
  'G8 a SECOND call is refused: once one platform admin exists this function can never add another'
);

select is((select count(*)::int from public.platform_admins), 1,
  'G9 and the refusal wrote nothing - the count is still exactly one');

-- ===== G10: not a client-callable function ================================
-- The grant that matters most: the function that mints the account which
-- bypasses every policy must not itself be callable by a client.
set role authenticated;
select throws_ok(
  $$select public.bootstrap_platform_admin('vendor@lensypos.local')$$,
  '42501',
  null,
  'G10 execute is revoked from authenticated, so a client cannot bootstrap anybody'
);
reset role;

-- ===== G11: the migration recorded itself ==================================
-- Asserted as "at least 021", NOT "equals 21": a later migration legitimately
-- moves this number on, and a hardcoded equality here would turn every future
-- migration into a red build in a file that has nothing to do with it. The
-- other half of that invariant - that the app's EXPECTED_SCHEMA_VERSION names
-- the newest migration - is pinned in web/src/lib/schemaVersion.test.ts, which
-- is where a number that DOES change belongs.
select ok(public.schema_version() >= 21,
  'G11 021 recorded itself, so the drift check can see it was applied');

rollback;
