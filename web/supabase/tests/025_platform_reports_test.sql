-- ===========================================================================
-- 025 - consolidated multi-store reporting.
--
-- WHY THIS GATE EXISTS. Every other report function here is single-store BY
-- CONSTRUCTION: no store argument, store derived from auth_store_id(), so a
-- caller cannot ask for another shop's report. That is right for a POS, and it
-- is exactly why a vendor cannot answer "how are all my shops doing today?" -
-- the one question a platform admin exists to ask.
--
-- THE SENSITIVITY, stated plainly. This is the first surface in the application
-- that shows one store's money to somebody who does not belong to that store.
-- Six phases of tenant work have been about KEEPING APART; this is the one place
-- that deliberately reaches across. So the gate is not mainly about arithmetic -
-- it is about proving that reaching across happens for exactly one kind of caller
-- and nobody else. G-A1 and G-A2 are the assertions that matter; the rest prove
-- the numbers are honest once you are allowed in.
--
-- PER-STORE DAY BOUNDARIES. "Today" is ambiguous across stores in different
-- zones, and there are two honest answers: one shared UTC window, or one window
-- per store. This takes the second, so each row means that store's own trading
-- day. G-A6 is the assertion that fails under the first design, and is why.
-- ===========================================================================
begin;
create extension if not exists pgtap;

-- 14. Derived from the assertions below rather than remembered: a wrong plan
-- fails the file even when every assertion passes, and this repository has got
-- that wrong three times (022: 13, then 17, then 18).
select plan(14);

-- ===== fixtures ==============================================================
-- Two licensed stores in DIFFERENT zones. Both licensed: a rival that cannot
-- write would let a cross-tenant leak pass by being refused rather than by being
-- correct - run #76's failure mode.
insert into public.stores (id, name, time_zone) values
  ('eeeeeeee-eeee-4eee-8eee-000000000051', 'y cairo', 'Africa/Cairo'),
  ('eeeeeeee-eeee-4eee-8eee-000000000052', 'y utc',   'UTC')
on conflict (id) do nothing;

create function y_store() returns uuid
  language sql stable as $$
  select 'eeeeeeee-eeee-4eee-8eee-000000000051'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (y_store(), 'STORE-Y', 'pro', null),
       ('eeeeeeee-eeee-4eee-8eee-000000000052', 'STORE-YR', 'pro', null)
on conflict (store_id) do nothing;

-- A SHOP ADMIN of the Cairo store, and a PLATFORM ADMIN. The whole gate is the
-- distance between these two people.
insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'yadmin@lensypos.local', 'yadmin'),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'yboss@lensypos.local',  'yboss')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active) values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'yadmin', '-', y_store(), true),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'yboss',  '-', y_store(), true)
on conflict (id) do nothing;

-- yboss is a platform admin. is_platform_admin() (008:211) is a plain exists()
-- over platform_admins on auth_uid, and that table is deliberately locked, so
-- the row is planted as the migration's owner - which is what a real setup does
-- through bootstrap_platform_admin (021).
insert into public.platform_admins (auth_uid)
values ('eeeeeeee-eeee-4eee-8eee-000000000062')
on conflict (auth_uid) do nothing;

-- The day's money.
--   Y1  1000 at 10:00 UTC -> 13:00 Cairo: the 20th in BOTH zones.
--   Y2  900, VOIDED: must not be revenue anywhere.
--   Y3  500 with a 200 refund: net_amount stays 500, amount_paid nets to 300.
--   Y4  2000 at 22:00 UTC on the 20th. In UTC that is the 20th; in Cairo (+3) it
--       is 01:00 on the 21st. One instant, two honest answers, and the whole
--       reason this report is built per store rather than per UTC window.
insert into public.sales (id, invoice_no, total_amount, discount, net_amount,
                          amount_paid, order_date, lab_status, kind, store_id)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000071', 'Y0001', 1000, 0, 1000, 1000,
   '2026-09-20 10:00:00+00', 'Ready', 'sale', y_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000072', 'Y0002',  900, 0,  900,  900,
   '2026-09-20 11:00:00+00', 'Ready', 'sale', y_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000073', 'Y0003',  500, 0,  500,  500,
   '2026-09-20 12:00:00+00', 'Ready', 'sale', y_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000074', 'Y0004', 2000, 0, 2000, 2000,
   '2026-09-20 22:00:00+00', 'Ready', 'sale',
   'eeeeeeee-eeee-4eee-8eee-000000000052')
on conflict (id) do nothing;

-- The void, by hand: the assertion is about how the REPORT treats a void, not
-- about void_sale working - 013's 41 assertions own that.
update public.sales set voided_at = '2026-09-20 11:30:00+00', void_reason = 'gate'
 where id = 'eeeeeeee-eeee-4eee-8eee-000000000072';

-- The ledger. 011's sync trigger recomputes sales.amount_paid from these rows, so
-- the refund comes off the header on its own - run #80's lesson about asserting
-- a value the trigger overwrites.
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000071', 1000, 'cash', 'payment', '2026-09-20 10:00:00+00', y_store()),
       ('eeeeeeee-eeee-4eee-8eee-000000000072',  900, 'cash', 'payment', '2026-09-20 11:00:00+00', y_store()),
       ('eeeeeeee-eeee-4eee-8eee-000000000072', -900, 'cash', 'refund',  '2026-09-20 11:30:00+00', y_store()),
       ('eeeeeeee-eeee-4eee-8eee-000000000073',  500, 'cash', 'payment', '2026-09-20 12:00:00+00', y_store()),
       ('eeeeeeee-eeee-4eee-8eee-000000000073', -200, 'cash', 'refund',  '2026-09-20 12:30:00+00', y_store()),
       ('eeeeeeee-eeee-4eee-8eee-000000000074', 2000, 'cash', 'payment', '2026-09-20 22:00:00+00',
        'eeeeeeee-eeee-4eee-8eee-000000000052');

-- Scratch register for the platform admin's rows, so the capture cannot abort the
-- TAP stream.
create table _cap (k text primary key, rev bigint, paid bigint, zone text);
grant all on _cap to authenticated;

create function _imp(p_uid uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text)::text, false);
end $$;

create function _grab(p_k text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_row record;
begin
  for v_row in select * from public.platform_report_window('2026-09-20'::date)
  loop
    insert into _cap (k, rev, paid, zone)
    values (p_k || v_row.store_id::text, v_row.revenue::bigint, v_row.paid::bigint,
            v_row.time_zone);
  end loop;
end $$;

grant execute on function _grab(text) to authenticated;

-- ===== the gate =============================================================
-- From here the session is an ordinary authenticated caller. The refusals below
-- are asserted against the FUNCTION ITSELF and not through a helper: a helper
-- that catches exceptions would swallow the very thing being tested, which is
-- exactly the mistake this gate made on its first run.
set role authenticated;

-- G-A1. THE ASSERTION THAT MATTERS. A shop admin, who may see every figure in
-- their own store, is refused the cross-store report.
select _imp('eeeeeeee-eeee-4eee-8eee-000000000061');
select throws_ok($$ select * from public.platform_report_window('2026-09-20'::date) $$,
  'P0001', 'platform admin only',
  'G-A1 a shop admin is refused the cross-store report');

-- G-A2 ...and so is a signed-in caller with no platform admin standing.
select _imp('eeeeeeee-eeee-4eee-8eee-000000000061');
select throws_ok($$ select * from public.platform_report_window('2026-09-20'::date) $$,
  'P0001', 'platform admin only',
  'G-A2 the refusal names the reason, so it is the gate and not a crash');

-- G-A3. The refusal is SPECIFIC. The same shop admin must still get their own
-- store's report: a gate that proves only "this is blocked" passes just as
-- happily against a function that breaks every caller, including the vendor.
select is((select revenue::bigint from public.report_sales_window(
             (select from_at from public.store_day_range('2026-09-20'::date)),
             (select to_at   from public.store_day_range('2026-09-20'::date)))),
  1500::bigint,
  'G-A3 the shop admin still gets their own store report - the block is narrow');

-- G-A4. A platform admin gets one row per store, for both shops.
select _imp('eeeeeeee-eeee-4eee-8eee-000000000062');
select _grab('boss');
-- Counting the two FIXTURE stores rather than the whole result set. The first
-- version of this assertion expected exactly two rows and failed with "have: 3",
-- and the database was right: 008 seeds a real 'Main Store' (008:70), so every
-- migrated database already contains a third store. This is runs #84/#85's
-- mistake again - a fixture written for a state the migrations had already been
-- through - and it is worth naming because a vendor report SHOULD show a shop
-- that sold nothing today as a row of zeros, not as a missing row.
select is((select count(*)::bigint from _cap
            where k in ('boss' || y_store()::text,
                        'bosseeeeeeee-eeee-4eee-8eee-000000000052')),
  2::bigint, 'G-A4 the platform admin gets a row for each of the two fixture stores');

-- G-A5. Cairo's day: Y1 counts, Y2 is voided out. 1000, not 1900.
select is((select rev from _cap where k = 'boss' || y_store()::text),
  1500::bigint, 'G-A5 a void is not revenue in the platform report either');

-- G-A6. THE DESIGN PINNED. Y4 is one instant at 22:00 UTC on the 20th. The UTC
-- store counts it; the Cairo store, whose day had already rolled over, does not.
-- A shared-UTC-window design counts it for both and this fails.
select is((select rev from _cap where k = 'bosseeeeeeee-eeee-4eee-8eee-000000000052'),
  2000::bigint, 'G-A6a the UTC store counts the 22:00 sale on its own 20th');

select is((select rev from _cap where k = 'boss' || y_store()::text),
  1500::bigint, 'G-A6b ...and the Cairo store does not, because its day had ended');

-- G-A7. The rows are disjoint and a vendor total is their sum, not a second and
-- differently-computed number.
select is((select sum(rev)::bigint from _cap),
  (select rev from _cap where k = 'boss' || y_store()::text)
  + (select rev from _cap where k = 'bosseeeeeeee-eeee-4eee-8eee-000000000052'),
  'G-A7 the rows are disjoint and their total is their sum');

-- G-A8. Each row carries its OWN zone, so the client can say which day it is
-- describing instead of inventing one.
select is((select zone from _cap where k = 'boss' || y_store()::text),
  'Africa/Cairo', 'G-A8a the Cairo row carries the Cairo zone');

select is((select zone from _cap where k = 'bosseeeeeeee-eeee-4eee-8eee-000000000052'),
  'UTC', 'G-A8b the UTC row carries the UTC zone');

-- G-A9. Refunds net into paid (1000 + 500 - 200) while revenue stays gross of
-- them, and the void contributes to neither. A void is EXCLUDED here, unlike in
-- z_report: this is revenue, not a drawer, and 016's report_sales_window is the
-- precedent.
select is((select paid from _cap where k = 'boss' || y_store()::text),
  1300::bigint, 'G-A9 refunds net into paid, and the void contributes nothing');

reset role;

-- G-A10. The index this needs. sales_live_idx leads with store_id, so a filter on
-- order_date across every store cannot use it; without a date-leading index this
-- report is a sequential scan of the whole table at exactly the scale the
-- reporting phase exists to avoid.
select ok(exists (select 1 from pg_indexes
                    where schemaname = 'public' and tablename = 'sales'
                      and indexdef ~* '\(order_date'),
  'G-A10 a date-leading index on sales(order_date) exists for the cross-store scan');

-- G-A11. The refusal lives in SQL, not only in the client: resolved by OID
-- because has_function_privilege raises 42883 on a signature mismatch instead of
-- returning false (run #67's trap).
select ok(not has_function_privilege(
           'anon',
           (select p.oid from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'platform_report_window'
            limit 1),
           'EXECUTE'),
  'G-A11 anon cannot execute it at all, so the refusal is not only in the body');

-- G-A12. 025 recorded itself. 018 and 019 shipped without this, and a
-- fully-migrated shop was indistinguishable from one stuck at 017 - the drift
-- check could not notice a version it never received.
select ok(exists (select 1 from public.lensy_schema_versions where version = 25),
  'G-A12 025 recorded its own version, so the drift banner can fire');

rollback;
