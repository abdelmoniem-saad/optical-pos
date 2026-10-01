-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 6 gate: 024_closing_permission_test.sql (pgTAP)
-- ============================================================
-- 023 gated closing the till on `reports.edit`. That couples two decisions a
-- shop wants to make separately: a manager who reviews the numbers, and a
-- cashier who counts the drawer at closing time. 024 splits them into
-- `closing.view` and `closing.edit`, and SEEDS them - because a new code with
-- no role holding it is a feature that is dead on arrival, which is the trap
-- 021 walked into.
--
--   G-P1  both codes are in the catalogue
--   G-P2  the seed grants BOTH closing codes to a role holding reports.edit
--   G-P3  ...and grants NEITHER to a role holding only reports.view, so removing
--         Reports from a cashier does not silently hand them the till
--   G-P4  a per-person grant of reports.edit is seeded too
--   G-P5  a caller holding BOTH reports.edit and closing.edit can close
--   G-P6  reports.edit ALONE is refused - the pre-024 world, proved with the old
--         permission in hand - and the refusal wrote NO row
--   G-P7  a caller with closing.edit and NO reports permission can close: the
--         whole use case, and the row is really there
--   G-P8  a caller with neither is refused
--   G-P9  closing.view does not confer closing.edit
--   G-P10 the seed is idempotent - a second run creates nothing
--   G-P11 024 stamped itself
--
-- ORDER MATTERS, and it is the whole design of this gate. The fixtures are
-- created FIRST and the seed is CALLED by the gate, rather than the seed running
-- at migration time and the gate observing it.
--
-- That is not a style preference. A gate builds a fresh database and creates
-- its own rows AFTER the migrations have already run, so a migration-time seed
-- has nothing to act on and cannot be tested at all - which is precisely the
-- wall 019 hit with its lab-dwell backfill, recorded in the roadmap as "the
-- backfill itself is not gated, and cannot be". Extracting the seed into
-- `seed_closing_permissions()` makes it both testable and re-runnable by a shop
-- that adds a role later, so there was no reason to give up the check.
--
-- G-P3 is the assertion that makes this migration worth having. G-P2 alone would
-- pass while the seed also handed the till to every read-only viewer, which is
-- the exact coupling 024 exists to remove.
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 14. Re-derived from the assertions, not remembered: a short plan makes
-- pgTAP fail the whole file on completion even when every assertion passed.
select plan(14);

-- ===== fixtures ==============================================================
-- One store, licensed: close_shift calls z_report, which is tenant-scoped, and a
-- refusal must not be reachable only because the shop is unlicensed (run #76).
insert into public.stores (id, name) values
  ('eeeeeeee-eeee-4eee-8eee-000000000041', 'perm store')
  on conflict (id) do nothing;

create function p_store() returns uuid
  language sql stable as $$
  select 'eeeeeeee-eeee-4eee-8eee-000000000041'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (p_store(), 'STORE-PERM', 'pro', null)
on conflict (store_id) do nothing;

-- Three roles, built to separate the two decisions:
--   p_both   - reports.edit  -> the seed should give it BOTH closing codes
--   p_viewer - reports.view only -> the seed should give it NEITHER
--   p_plain  - nothing at all; gets closing.edit by hand instead
insert into public.roles (id, name, store_id) values
  ('eeeeeeee-eeee-4eee-8eee-000000000051', 'P Both',   p_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000052', 'P Viewer', p_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000053', 'P Plain',  p_store())
on conflict (id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.id = 'eeeeeeee-eeee-4eee-8eee-000000000051'
   and p.code = 'reports.edit'
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.id = 'eeeeeeee-eeee-4eee-8eee-000000000052'
   and p.code = 'reports.view'
on conflict (role_id, permission_id) do nothing;

-- Four people:
--   pd_both  - pdirect's reports.edit comes from the P Both role (seeded)
--   pdirect  - reports.edit granted to the PERSON, not the role, so G-P4 can
--              prove the seed covers user_permissions as well
--   pplain   - closing.edit BY HAND with no reports code at all: the shop that
--              took Reports from its cashiers and gave them the till instead
--   pnone    - closing.VIEW only, to prove view and edit are not the same act
insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'pboth@lensypos.local',   'pboth'),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'pdirect@lensypos.local', 'pdirect'),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', 'pplain@lensypos.local',  'pplain'),
  ('eeeeeeee-eeee-4eee-8eee-000000000064', 'pnone@lensypos.local',   'pnone')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active, role_id)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'pboth',   '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000051'),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'pdirect', '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000053'),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', 'pplain',  '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000053'),
  ('eeeeeeee-eeee-4eee-8eee-000000000064', 'pnone',   '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000053')
on conflict (id) do nothing;

-- pdirect's reports.edit is granted to the PERSON.
insert into public.user_permissions (user_id, permission_id, allow)
select 'eeeeeeee-eeee-4eee-8eee-000000000062', p.id, true
  from public.permissions p where p.code = 'reports.edit'
on conflict (user_id, permission_id) do nothing;

-- pplain gets closing.edit and closing.view directly, with NO reports code.
insert into public.user_permissions (user_id, permission_id, allow)
select 'eeeeeeee-eeee-4eee-8eee-000000000063', p.id, true
  from public.permissions p where p.code in ('closing.view', 'closing.edit')
on conflict (user_id, permission_id) do nothing;

-- pnone gets closing.VIEW only.
insert into public.user_permissions (user_id, permission_id, allow)
select 'eeeeeeee-eeee-4eee-8eee-000000000064', p.id, true
  from public.permissions p where p.code = 'closing.view'
on conflict (user_id, permission_id) do nothing;

create table _cap (k text primary key, close_id uuid, err text);
grant all on _cap to authenticated;

create function _close(p_k text) returns void
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.close_shift('2026-09-20 00:00:00+00'::timestamptz,
                              '2026-09-21 00:00:00+00'::timestamptz,
                              0, 'gate')).id;
  insert into _cap (k, close_id) values (p_k, v_id);
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

create function _imp(p_uid uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end $$;

create function _role_has(p_role uuid, p_code text) returns boolean
  language sql stable as $$
  select exists (
    select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
     where rp.role_id = p_role and p.code = p_code) $$;

create function _user_has(p_uid uuid, p_code text) returns boolean
  language sql stable as $$
  select exists (
    select 1 from public.user_permissions up
      join public.permissions p on p.id = up.permission_id
     where up.user_id = p_uid and p.code = p_code and up.allow is not false) $$;

-- ===== G-P1: the codes exist ================================================
select is((select count(*)::int from public.permissions
            where code in ('closing.view', 'closing.edit')), 2,
  'G-P1 both closing codes are in the catalogue, so the matrix can show them');

-- ===== G-P2 / G-P3: the seed ================================================
-- CALLED here rather than observed from migration time. See the header.
-- Four, not five: p_both's role gets two codes, pdirect's person grant gets
-- two, and p_plain's two were granted by hand in the fixture above rather
-- than by the seed. Counting the fixture's own rows here would have made this
-- assertion pass for the wrong reason.
select is(public.seed_closing_permissions(), 4,
  'G-P2 the seed creates exactly the grants it should: two for p_both''s role and two for pdirect, and nothing for anyone who lacks reports.edit');

select ok(_role_has('eeeeeeee-eeee-4eee-8eee-000000000051', 'closing.view')
   and _role_has('eeeeeeee-eeee-4eee-8eee-000000000051', 'closing.edit'),
  'G-P2b a role holding reports.edit ends up with BOTH closing codes');

-- The assertion that makes this migration worth having. G-P2b alone would pass
-- while the seed also handed the till to every read-only viewer, which is the
-- exact coupling 024 exists to remove.
select ok(not _role_has('eeeeeeee-eeee-4eee-8eee-000000000052', 'closing.view')
   and not _role_has('eeeeeeee-eeee-4eee-8eee-000000000052', 'closing.edit'),
  'G-P3 a role holding only reports.view is given NEITHER closing code');

select ok(_user_has('eeeeeeee-eeee-4eee-8eee-000000000062', 'closing.edit'),
  'G-P4 a person granted reports.edit directly keeps the capability');

-- ===== G-P5: both permissions, the seeded path ==============================
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000061');   -- pboth
select _close('both');
select is((select err from _cap where k = 'both'), null,
  'G-P5 a caller holding BOTH reports.edit and the seeded closing.edit can close');

-- ===== G-P6: reports.edit ALONE is no longer enough ==========================
-- The pre-024 world, proved by stripping the seeded grant and holding the OLD
-- permission in hand. This is the whole point of the migration.
reset role;
delete from public.role_permissions rp
  using public.roles r, public.permissions p
 where rp.role_id = r.id and rp.permission_id = p.id
   and r.id = 'eeeeeeee-eeee-4eee-8eee-000000000051'
   and p.code in ('closing.view', 'closing.edit');
set role authenticated;
select _close('reports_only');
select is((select err from _cap where k = 'reports_only') is not null, true,
  'G-P6 reports.edit alone is REFUSED - closing the till is a separate decision');
select is((select count(*)::int from public.shift_closes), 1,
  'G-P6b and the refusal wrote NO row - the check is enforcement, not a message');

-- ===== G-P7: closing.edit WITHOUT reports is the whole use case =============
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000063');   -- pplain
select _close('plain');
select is((select err from _cap where k = 'plain'), null,
  'G-P7 a cashier with closing.edit and NO reports permission can close the till');
select is((select count(*)::int from public.shift_closes), 2,
  'G-P7b and the row is really there');

-- ===== G-P8: neither ========================================================
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000064');   -- pnone, view only
select _close('none');
select is((select err from _cap where k = 'none') is not null, true,
  'G-P8 a caller with only closing.view is refused - seeing is not committing');

-- ===== G-P9: view is not edit ===============================================
reset role;
select ok(not _user_has('eeeeeeee-eeee-4eee-8eee-000000000064', 'closing.edit'),
  'G-P9 closing.view does not confer closing.edit - the two are distinct acts');

-- ===== G-P10: the seed is idempotent ========================================
-- A shop that adds a "shift supervisor" role next year runs this by hand, so
-- running it twice must be a no-op rather than an error.
select is(public.seed_closing_permissions(), 0,
  'G-P10 a second run creates nothing, so re-pasting or re-seeding is safe');

-- ===== G-P11: 024 stamped itself ============================================
select is((select max(version) from public.lensy_schema_versions) >= 24, true,
  'G-P11 024 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
