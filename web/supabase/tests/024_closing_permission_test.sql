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
--   G-P2  a role holding reports.edit is SEEDED with both closing codes - the
--         half that keeps the feature alive after a paste
--   G-P3  a role holding only reports.view gets NEITHER, so removing Reports
--         from a cashier does not silently hand them the till
--   G-P4  a per-person grant of reports.edit is seeded too
--   G-P5  a caller holding BOTH reports.edit and closing.edit can close
--   G-P6  reports.edit ALONE is refused - the pre-024 world, proved with the
--         old permission in hand - and the refusal wrote NO row
--   G-P7  a caller with closing.edit and NO reports permission can close: the
--         whole use case, and the row is really there
--   G-P8  a caller with neither is refused
--   G-P9  closing.view does not confer closing.edit - seeing the drawer and
--         declaring the drawer correct are different acts
--   G-P10 the seed created no duplicate grants, so re-pasting changes nothing
--   G-P11 024 stamped itself
--
-- Eleven items, 14 assertions: the three companions (G-P2b, G-P6b, G-P7b) each
-- pin a second half - the OTHER seeded code, the refusal writing nothing, and
-- the close being real.
--
-- G-P3 is the assertion that makes this migration worth having. G-P2 alone
-- would pass while the seed also handed the capability to every read-only
-- viewer, which is precisely the coupling 024 exists to remove.
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 14. Re-derived from the assertions, not remembered: a short plan
-- makes pgTAP fail the whole file on completion even when every
-- assertion passed.
select plan(14);

-- ===== fixtures ==============================================================
-- One store, licensed: close_shift calls z_report, which is tenant-scoped, and
-- a refusal path must not be reachable only because the shop is unlicensed
-- (run #76's failure mode).
insert into public.stores (id, name) values
  ('eeeeeeee-eeee-4eee-8eee-000000000041', 'perm store')
  on conflict (id) do nothing;

create function p_store() returns uuid
  language sql stable as $$
  select 'eeeeeeee-eeee-4eee-8eee-000000000041'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (p_store(), 'STORE-PERM', 'pro', null)
on conflict (store_id) do nothing;

-- Three roles, deliberately built to separate the two decisions:
--   p_both   - reports.edit  -> should end up with BOTH closing codes
--   p_viewer - reports.view only -> should end up with NEITHER
--   p_plain  - no reports anything, but closing.edit by hand -> can close
insert into public.roles (id, name, store_id) values
  ('eeeeeeee-eeee-4eee-8eee-000000000051', 'P Both',   p_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000052', 'P Viewer', p_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000053', 'P Plain',  p_store())
on conflict (id) do nothing;

-- Grant reports.edit to p_both, reports.view to p_viewer. p_plain gets
-- nothing - it is the "the shop removed Reports from this role" case.
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

-- A person whose reports.edit is granted DIRECTLY rather than through a role.
-- 024 seeds user_permissions as well, or this person would silently lose the
-- capability they had the moment the shop pasted it.
insert into public.auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'pdirect@lensypos.local', 'pdirect')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active, role_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000061', 'pdirect', '-', p_store(), true,
        'eeeeeeee-eeee-4eee-8eee-000000000051')
on conflict (id) do nothing;

insert into public.user_permissions (user_id, permission_id, allow)
select u.id, p.id, true
  from public.users u, public.permissions p
 where u.id = 'eeeeeeee-eeee-4eee-8eee-000000000061' and p.code = 'reports.edit'
on conflict (user_id, permission_id) do nothing;

-- The three callers, for the authorisation half. pd_both is seeded with the
-- closing codes by the migration itself; pd_plain is given closing.edit BY HAND,
-- with no reports permission at all - that is the whole use case.
insert into public.auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'pboth@lensypos.local',  'pboth'),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', 'pplain@lensypos.local', 'pplain'),
  ('eeeeeeee-eeee-4eee-8eee-000000000064', 'pnone@lensypos.local',  'pnone')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active, role_id)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'pboth',  '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000051'),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', 'pplain', '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000053'),
  ('eeeeeeee-eeee-4eee-8eee-000000000064', 'pnone',  '-', p_store(), true, 'eeeeeeee-eeee-4eee-8eee-000000000053')
on conflict (id) do nothing;

-- p_plain gets closing.edit and closing.view directly, with NO reports code.
-- This is the shop that took Reports away from its cashiers and gave them the
-- till instead, and it is the scenario 024 exists to make possible.
insert into public.user_permissions (user_id, permission_id, allow)
select 'eeeeeeee-eeee-4eee-8eee-000000000063', p.id, true
  from public.permissions p where p.code in ('closing.view', 'closing.edit')
on conflict (user_id, permission_id) do nothing;

-- p_none gets closing.VIEW only, to prove view and edit are not interchangeable.
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
select ok((select count(*) from public.permissions
            where code in ('closing.view', 'closing.edit')) = 2,
  'G-P1 both closing codes are in the catalogue, so the matrix can show them');

-- ===== G-P2: the seed — the half that keeps the feature alive ================
-- Without this the button is greyed out after the paste and nothing says why.
select ok(_role_has('eeeeeeee-eeee-4eee-8eee-000000000051', 'closing.view'),
  'G-P2 a role holding reports.edit is seeded with closing.view');
select ok(_role_has('eeeeeeee-eeee-4eee-8eee-000000000051', 'closing.edit'),
  'G-P2b ...and with closing.edit, so a shop that changes nothing loses nothing');

-- ===== G-P3: and the seed does NOT over-reach ==============================
-- The assertion that makes this migration worth having. G-P2 alone would pass
-- while the seed also handed the till to every read-only viewer - which is the
-- exact coupling 024 exists to remove.
select ok(not _role_has('eeeeeeee-eeee-4eee-8eee-000000000052', 'closing.view')
   and not _role_has('eeeeeeee-eeee-4eee-8eee-000000000052', 'closing.edit'),
  'G-P3 a role holding only reports.view is given NEITHER closing code');

-- ===== G-P4: a per-person grant is seeded too ===============================
select ok(_user_has('eeeeeeee-eeee-4eee-8eee-000000000061', 'closing.edit'),
  'G-P4 a person granted reports.edit directly keeps the capability');

-- ===== G-P5 / G-P6: the old permission is NOT enough any more ==============
-- Proved with reports.edit in hand, because that is precisely the caller 024
-- is redefining. Before this migration, pboth could close.
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000062');
select _close('both');
select is((select err from _cap where k = 'both') is null, true,
  'G-P5 a caller who holds BOTH reports.edit and the seeded closing.edit CAN close');

-- Strip the seeded grant and they hold reports.edit alone - the pre-024 world.
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
select is((select count(*)::int from public.shift_closes), 0::int,
  'G-P6b and the refusal wrote NO row');

-- ===== G-P7: closing.edit WITHOUT reports is the whole use case =============
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000063');
select _close('plain');
select is((select err from _cap where k = 'plain') is null, true,
  'G-P7 a cashier with closing.edit and NO reports permission can close the till');
select is((select count(*)::int from public.shift_closes), 1::int,
  'G-P7b and the row is really there');

-- ===== G-P8: neither ========================================================
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000064');
select _close('none');
select is((select err from _cap where k = 'none') is not null, true,
  'G-P8 a caller with no closing permission is refused');

-- ===== G-P9: view is not edit ===============================================
-- closing.view is what shows the figures; closing.edit is what commits them.
-- Collapsing them would let anyone who can SEE the drawer also declare the
-- drawer correct.
reset role;
select ok(
  (select count(*) from public.user_permissions up
     join public.permissions p on p.id = up.permission_id
    where up.user_id = 'eeeeeeee-eeee-4eee-8eee-000000000064'
      and p.code = 'closing.edit') = 0,
  'G-P9 closing.view alone does not confer closing.edit - the two are distinct');

-- ===== G-P10: re-pasting the seed is a no-op ================================
reset role;
select is((select count(*)::int from public.role_permissions), (
         select count(*)::int from (
           select distinct rp.role_id, rp.permission_id
             from public.role_permissions rp
            union
           select rp.role_id, rp.permission_id
             from public.role_permissions rp
             join public.permissions g on g.id = rp.permission_id
             join public.permissions n on n.code in ('closing.view','closing.edit')
            where g.code = 'reports.edit') u)),
  'G-P10 the seed created no duplicate grants, so re-pasting changes nothing');

-- ===== G-P11: 024 stamped itself ============================================
select is((select max(version) from public.lensy_schema_versions) >= 24, true,
  'G-P11 024 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
