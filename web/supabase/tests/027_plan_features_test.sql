-- ===========================================================================
-- 027 - plan feature flags, finally read.
--
-- WHY THIS GATE EXISTS. 008 created store_licenses.features (jsonb) and nothing
-- ever read it, so a vendor who "configured a plan flag" changed nothing. This
-- gate proves the flag is now REAL in exactly one place - the consolidated
-- platform report - and that adding it did not lock anybody out.
--
-- The two assertions that matter are G-F3 and G-F5:
--   G-F3  an admin whose store's plan EXCLUDES the feature is refused in SQL,
--         so the column stops being decorative;
--   G-F5  a NON-admin is still refused with 'platform admin only', NOT the
--         feature message - proving the two gates are independent. A gate that
--         only proved "refused" would pass against a function that breaks every
--         caller, and one that only proved the feature check would pass against
--         a function that forgot the admin check entirely.
--
-- G-F2 is the no-regression pin: an ABSENT flag reads ALLOWED, so pasting 027
-- does not silently revoke the report from a vendor who never set the flag.
-- That is the whole reason the default is opt-out rather than opt-in.
-- ===========================================================================
begin;
create extension if not exists pgtap;

-- 7. Derived from the assertions below rather than remembered.
select plan(7);

-- ===== fixtures ==============================================================
-- One licensed store in Cairo (the vendor's own) and a second licensed store,
-- because the platform report is cross-store and a gate with a single store
-- cannot tell "blocked" from "there is nothing to show".
insert into public.stores (id, name, time_zone) values
  ('ffffffff-ffff-4fff-8fff-000000000071', 'f cairo', 'Africa/Cairo'),
  ('ffffffff-ffff-4fff-8fff-000000000072', 'f utc',   'UTC')
on conflict (id) do nothing;

create function f_store() returns uuid
  language sql stable as $$
  select 'ffffffff-ffff-4fff-8fff-000000000071'::uuid $$;

-- NO features set here on purpose: the vendor's own licence carries the
-- DEFAULT '{}'. G-F2 depends on that being absent.
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (f_store(), 'STORE-F', 'pro', null),
       ('ffffffff-ffff-4fff-8fff-000000000072', 'STORE-FR', 'pro', null)
on conflict (store_id) do nothing;

-- A PLATFORM ADMIN whose own store is f_store(). The feature flag is read from
-- auth_store_id(), which for this account is f_store() - so the flag the report
-- checks is f_store()'s, not some other shop's.
insert into auth.users (id, email, username) values
  ('ffffffff-ffff-4fff-8fff-000000000081', 'fboss@lensypos.local', 'fboss'),
  ('ffffffff-ffff-4fff-8fff-000000000082', 'fshop@lensypos.local', 'fshop')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active) values
  ('ffffffff-ffff-4fff-8fff-000000000081', 'fboss', '-', f_store(), true),
  ('ffffffff-ffff-4fff-8fff-000000000082', 'fshop', '-', f_store(), true)
on conflict (id) do nothing;

insert into public.platform_admins (auth_uid)
values ('ffffffff-ffff-4fff-8fff-000000000081')
on conflict (auth_uid) do nothing;

create function _imp(p_uid uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text)::text, false);
end $$;

-- ===== 1) the reader exists ==================================================
-- to_regprocedure, not has_function: has_function PERFORMS a test and returns
-- its TAP line (text), so wrapping it in is() types as is(text, boolean,
-- unknown) and does not exist - 026's lesson. to_regprocedure is
-- signature-exact and boolean.
select is((to_regprocedure('public.license_feature(text)') is not null), true,
  'G-F1 license_feature(text) exists - features is no longer a dead column');

-- ===== 2) the flag is read as the vendor ====================================
set role authenticated;
select _imp('ffffffff-ffff-4fff-8fff-000000000081'::uuid);   -- the platform admin

-- G-F2. THE NO-REGRESSION PIN. f_store()'s licence has NO features key, so an
-- absent flag must read ALLOWED. If this were false, pasting 027 would revoke
-- the platform report from every vendor who never set the flag.
select is(public.license_feature('platform_report'), true,
  'G-F2 an ABSENT flag reads allowed - pasting 027 does not revoke the report');

-- A feature nobody has ever heard of also reads allowed (same default), and a
-- malformed value is allowed rather than an error - the reader never aborts.
select is(public.license_feature('some_future_feature'), true,
  'G-F2b an unknown feature reads allowed too - the default is opt-out');

-- ===== 3) an explicit off is honoured, in SQL ===============================
-- Flip f_store()'s flag OFF as the superuser (the platform admin cannot write
-- their own licence - 026 proved that), then ask again.
reset role;
update public.store_licenses
   set features = features || '{"platform_report": false}'::jsonb
 where store_id = f_store();

set role authenticated;
select _imp('ffffffff-ffff-4fff-8fff-000000000081'::uuid);

-- G-F3. THE ASSERTION THAT MATTERS. The flag is now false for this admin's own
-- store, so the consolidated report is refused IN SQL. This is what makes the
-- column stop being decorative.
select throws_ok(
  $$ select public.platform_report_window() $$,
  'P0001', 'platform_report not enabled on this plan',
  'G-F3 a platform admin whose plan excludes the feature is refused, in SQL');

-- ===== 4) restore the flag; the report works again ==========================
reset role;
update public.store_licenses
   set features = features || '{"platform_report": true}'::jsonb
 where store_id = f_store();

set role authenticated;
select _imp('ffffffff-ffff-4fff-8fff-000000000081'::uuid);

-- G-F4. With the flag explicitly on, the same call succeeds and returns the
-- fixture stores - proving the refusal above was the flag, not a broken
-- function. Asserts that BOTH fixture stores appear rather than a row count:
-- 008 seeds a real 'Main Store' into every migrated database, so the total is
-- 3, not 2 (run #84/#85's mistake, and 025's G-A4 note says the same). The
-- claim is "the report runs and shows my shops", not "the table has N rows".
select is((
  select count(*)::bigint from public.platform_report_window()
   where store_id in (f_store(), 'ffffffff-ffff-4fff-8fff-000000000072'::uuid)
), 2::bigint,
  'G-F4 with the flag on, both fixture stores appear - the refusal was the flag');

-- ===== 5) the two gates are independent =====================================
-- G-F5. A NON-admin is refused with 'platform admin only', NOT the feature
-- message - even though the feature is on. Impersonate the shop admin FIRST:
-- still acting as fboss here would call the report successfully and the
-- assertion would see "no exception". If the admin check had been dropped in
-- favour of the feature check, this would pass the wrong refusal; if the
-- feature check fired first, the message would be the feature one. Both being
-- present and ordered is the property under test.
select _imp('ffffffff-ffff-4fff-8fff-000000000082'::uuid);   -- fshop, NOT an admin
select throws_ok(
  $$ select public.platform_report_window() $$,
  'P0001', 'platform admin only',
  'G-F5 a non-admin is refused as admin-only, not as feature-off - the gates are independent');

-- ===== 6) 027 recorded itself ==============================================
reset role;
select is((exists (select 1 from public.lensy_schema_versions where version = 27)), true,
  'G-F9 027 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
