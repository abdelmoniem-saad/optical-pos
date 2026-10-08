-- ===========================================================================
-- 026 - the licence window.
--
-- WHY THIS GATE EXISTS. A licence is the one row that decides whether a shop can
-- sell at all, and 008 created `starts_at` on it and then never once read it.
-- license_read_ok / license_write_ok / my_license_state all decided "active"
-- from `is_revoked` and `expires_at` alone, so a licence bought to BEGIN NEXT
-- MONTH was live TODAY. The column existed, looked configurable, and did nothing.
--
-- The second defect is the one that quietly cost money. The platform page wrote
-- the expiry picker straight into a timestamptz as a bare 'YYYY-MM-DD', which
-- Postgres casts in the SESSION timezone at 00:00 - so "expires 2026-12-31"
-- was dead from the START of the 31st. Every renewal silently lost a day. Phase 4
-- recorded this exact trap for Reports; it was sitting on the field that gates
-- trading, where nobody would think to look for it.
--
-- The assertions that matter are G-L1..G-L3 (the start date is honoured at all)
-- and G-L9/G-L10 (the day boundary is EXCLUSIVE and store-local). Together they are the
-- difference between a licence that says what a person meant and one that does not.
-- ===========================================================================
begin;
create extension if not exists pgtap;

-- 19. Derived from the assertions below rather than remembered.
select plan(19);

-- ===== fixtures ==============================================================
-- ONE licensed store and one unlicensed, both Africa/Cairo. The rival is
-- unlicensed on purpose this time: every assertion here is about LICENCE state,
-- so a rival that could not write for lack of a licence would make a refusal
-- ambiguous - and 025's lesson is that a rival which cannot act lets a tenant
-- check pass for the wrong reason.
insert into public.stores (id, name, time_zone) values
  ('dddddddd-dddd-4ddd-8ddd-000000000061', 'Licence Shop',    'Africa/Cairo'),
  ('dddddddd-dddd-4ddd-8ddd-000000000062', 'Never Licensed',  'Africa/Cairo')
on conflict (id) do nothing;

create function l_store() returns uuid language sql stable as $$
  select 'dddddddd-dddd-4ddd-8ddd-000000000061'::uuid $$;

-- THE FIXTURE IS THE DEFECT. A licence that starts a month from now and expires
-- a year later: on 008's definitions this is 'active' right now.
insert into public.store_licenses (store_id, license_key, plan, starts_at, expires_at)
values (l_store(), 'STORE-L1', 'pro',
        now() + interval '30 days',
        now() + interval '395 days')
on conflict (store_id) do nothing;

-- A SHOP ADMIN of that store, and a PLATFORM ADMIN. The whole gate is the
-- distance between these two people.
insert into auth.users (id, email, username) values
  ('dddddddd-dddd-4ddd-8ddd-000000000071', 'lshop@lensypos.local',  'lshop'),
  ('dddddddd-dddd-4ddd-8ddd-000000000072', 'lboss@lensypos.local',  'lboss')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active) values
  ('dddddddd-dddd-4ddd-8ddd-000000000071', 'lshop', '-', l_store(), true),
  ('dddddddd-dddd-4ddd-8ddd-000000000072', 'lboss', '-', l_store(), true)
on conflict (id) do nothing;

insert into public.platform_admins (auth_uid)
values ('dddddddd-dddd-4ddd-8ddd-000000000072')
on conflict (auth_uid) do nothing;

-- Run #77's lesson: a gate that never impersonates anybody passes for entirely
-- the wrong reason. auth_store_id() is NULL with no JWT, license_*_ok() would
-- return false for a store nobody asked about, and every "is refused" assertion
-- below would be true without the caller ever existing.
create function _imp(p_uid uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text)::text, false);
end $$;

-- ===== 1) the start date is honoured =======================================
-- Nothing below needed the RPCs to prove itself: these three are the ORIGINAL
-- defect, and they fail against the unpatched database on their own.

select is(public.license_write_ok(l_store()), false,
  'G-L1 a licence that has not STARTED yet does not permit writes');

select is(public.license_read_ok(l_store()), false,
  'G-L2 ...and does not permit reads either - a future licence is not a licence');

select _imp('dddddddd-dddd-4ddd-8ddd-000000000071'::uuid);
select is((select state from public.my_license_state()), 'pending',
  'G-L3 the app is told PENDING, not told the shop is trading early');

-- From here on every assertion runs AS the caller. pgTAP's ok() is not
-- reachable as `authenticated` in this plain-Postgres harness (it lands in
-- public, but ok() specifically is not in the default-privilege grant the shim
-- sets up), so the assertions below use is()/throws_ok() - which ARE - and
-- finish() waits for `reset role` at the end of the file (023's pattern).
set role authenticated;

-- ===== 2) the RPCs exist, and only a platform admin may call them ==========
-- has_function() PERFORMS a test and returns its TAP line (text) in this pgTAP -
-- wrapping it in is() types as is(text, boolean, unknown) and does not exist.
-- to_regprocedure() is signature-exact and boolean, so the assertion below also
-- fails if the signature ever drifts, not merely the name.
select is((to_regprocedure('public.set_license_window(uuid,date,date,text,integer,text)') is not null), true, 'G-L4 set_license_window exists - the browser no longer writes this column');

select is((to_regprocedure('public.set_license_revoked(uuid,boolean)') is not null), true, 'G-L5 set_license_revoked exists, so revoking is its own decision');

-- THE ASSERTION THAT MATTERS MOST for authorisation: a shop admin, who can see
-- every figure in their own store, cannot extend their own licence.
select _imp('dddddddd-dddd-4ddd-8ddd-000000000071'::uuid);
select throws_ok(
  $$ select public.set_license_window(l_store(), '2027-01-01'::date, '2027-12-31'::date) $$,
  '42501', 'platform admin only',
  'G-L6 a SHOP ADMIN cannot write their own licence');

select throws_ok(
  $$ select public.set_license_revoked(l_store(), true) $$,
  '42501', 'platform admin only',
  'G-L7 ...nor revoke their own');

-- The platform admin can. Exact message, because throws_ok compares by equality
-- and treats the string as literal text - run #92's lesson.
select _imp('dddddddd-dddd-4ddd-8ddd-000000000072'::uuid);
select is((
  public.set_license_window(l_store(), '2026-12-01'::date, '2026-12-31'::date, 'pro', 5) is not null), true, 'G-L8 a PLATFORM ADMIN can set the window');

-- ===== 3) the day boundary ==================================================
-- THE LOAD-BEARING ASSERTION. Cairo is SEASONAL: UTC+3 on summer DST, UTC+2 on
-- winter standard time (Egypt reintroduced seasonal changes in 2023 and does fall
-- back - December 2026 is winter, so local midnight is 22:00 UTC, not 21:00).
--   start  2026-12-01 -> 2026-11-30 22:00:00+00
--   expiry 2026-12-31 -> 2026-12-31 22:00:00+00  (the EXCLUSIVE end)
-- Pinned as INSTANTS, not zone-relative strings: the old behaviour cast the bare
-- date in the SESSION's zone, so under any session timezone it stored a different
-- instant than the shop's - and the shop loses hours, or the whole last day, of
-- every licence it ever buys.
select is(
  (select starts_at from public.store_licenses where store_id = l_store()),
  '2026-11-30 22:00:00+00'::timestamptz,
  'G-L9 the start date is the START of that day in the SHOP''s zone');

select is(
  (select expires_at from public.store_licenses where store_id = l_store()),
  '2026-12-31 22:00:00+00'::timestamptz,
  'G-L10 the expiry is the EXCLUSIVE end, so the shop keeps its last day');

select is(
  (select max_staff from public.store_licenses where store_id = l_store()),
  5,
  'G-L11 max_staff is settable - create-user already enforces it, nothing could edit it');

-- A window that ends before it starts is refused, with both dates in the message.
select throws_ok(
  $$ select public.set_license_window(l_store(), '2026-02-01'::date, '2026-01-01'::date) $$,
  '22023', 'expiry date 2026-01-01 is before start date 2026-02-01',
  'G-L12 expiry before start is refused, naming both dates');

-- A perpetual licence stays legal: 009 seeds exactly that.
select is((
  public.set_license_window(l_store(), '2026-12-01'::date, null, 'pro', null) is not null), true, 'G-L13 a perpetual licence (no expiry) is still expressible');

-- ===== 4) revoking, and NOT un-revoking by accident =========================
-- The old date picker carried `is_revoked: false` inside its update, so typing a
-- new date into a revoked licence quietly brought it back to life.
select is((public.set_license_revoked(l_store(), true) is not null), true, 'G-L14 a platform admin can revoke');

select is(public.license_write_ok(l_store()), false,
  'G-L15 a revoked licence permits no writes');

select is((public.set_license_window(l_store(), '2026-12-01'::date, '2027-12-31'::date) is not null), true, 'G-L16 setting new dates on a revoked licence still succeeds');

select is(public.license_write_ok(l_store()), false,
  'G-L17 ...but it stayed REVOKED - editing dates is not revoking, and revoking is not editing dates');

-- ===== 5) refusals that are not about permissions ===========================
select throws_ok(
  $$ select public.set_license_revoked('dddddddd-dddd-4ddd-8ddd-000000000062'::uuid, true) $$,
  '22023', 'store has no license to revoke',
  'G-L18 a store that was never licensed says so, rather than "no such store"');

-- ===== 6) the version stamp ================================================
-- Read as the migration's own role, not the caller's: lensy_schema_versions
-- has RLS on and no direct read for a client, so asking as authenticated would
-- report an empty ledger and pass for the wrong reason. 023's G-Z14, same
-- reasoning - and the same `reset role` that makes finish() resolvable here.
reset role;
select is((exists (select 1 from public.lensy_schema_versions where version = 26)), true, 'G-L19 026 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
