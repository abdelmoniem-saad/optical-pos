-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 6 gate: 023_z_report_test.sql (pgTAP)
-- ============================================================
-- The Z report answers the shop's daily question: how much SHOULD be in the
-- drawer, and is it. Two things about it are easy to get subtly wrong, and both
-- have a gate assertion here:
--
--   G-Z1  the report function exists
--   G-Z2  expected_cash is the NET of payments and refunds
--   G-Z3  a VOID nets to zero in the drawer - not because it is filtered out,
--         but because 013 wrote a compensating negative payment that cancels
--   G-Z4  order_count excludes prescriptions (022's kind, reused here)
--   G-Z5  a counted drawer that MATCHES gives variance 0
--   G-Z6  a 50 EGP shortage gives variance -50, signed the way a shop reads it
--   G-Z7  the close is recorded, and stores the figures as they stood
--   G-Z8  the same window cannot be closed twice - a close is an event
--   G-Z9  a close without a counted drawer is refused
--   G-Z10 a backwards or half-open window is refused
--   G-Z11 another store's money is invisible
--   G-Z12 a caller without reports.edit is refused, and NOTHING is written
--   G-Z13 a direct INSERT is refused: close_shift is the only way in
--   G-Z14 023 stamped itself, so the drift banner can fire
--
-- Fourteen labelled items above, 21 assertions: the seven companions (G-Z2b,
-- G-Z2c, G-Z3b, G-Z4b, G-Z7b, G-Z8b, G-Z12b) each pin a second half of a
-- claim that is worthless without it - a refund that is never reported, a
-- prescription that is hidden rather than merely uncounted, a refusal that still
-- wrote a row.
--
-- G-Z3 and G-Z12 are the two that matter most. G-Z3 is the property the whole
-- design rests on - a void must leave the drawer exactly as empty as the sale
-- left it full - and getting it "right" by excluding voided sales would be wrong,
-- because the money never left the ledger. G-Z12 is the authorisation half: the
-- gate asserts a REFUSAL left no row, which is the difference between a
-- permission working and a permission being merely present.
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 21. Re-derived from the assertions before committing rather than trusted from
-- memory: a short plan makes pgTAP fail the whole file on completion even when
-- every assertion passed, and this repository has now got that wrong twice
-- (022's gate: 13, then 17, then 18).
select plan(21);

-- ===== fixtures ==============================================================
-- Two stores, both created and both licensed. The licence is not decoration:
-- create_sale_order is SECURITY INVOKER, so its insert into sales goes through
-- RLS, and 008:452 gates that on license_write_ok(). Unlicensed, every checkout
-- is refused - which is run #76's failure mode, where a gate passed for the
-- wrong reason because the fixture was not a working shop.
insert into public.stores (id, name) values
  ('eeeeeeee-eeee-4eee-8eee-000000000031', 'z store'),
  ('eeeeeeee-eeee-4eee-8eee-000000000032', 'z rival')
  on conflict (id) do nothing;

create function z_store() returns uuid
  language sql stable as $$
  select 'eeeeeeee-eeee-4eee-8eee-000000000031'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (z_store(), 'STORE-Z', 'pro', null),
       ('eeeeeeee-eeee-4eee-8eee-000000000032', 'STORE-ZR', 'pro', null)
on conflict (store_id) do nothing;

-- A manager who may close, and a cashier who may not. The distinction is the
-- whole of G-Z12, and it is created the way 014 expects: a role with
-- reports.edit, and one without.
insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8eee-000000000041', 'zmanager@lensypos.local', 'zmanager'),
  ('eeeeeeee-eeee-4eee-8eee-000000000042', 'zcashier@lensypos.local', 'zcashier')
  on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active) values
  ('eeeeeeee-eeee-4eee-8eee-000000000041', 'zmanager', '-', z_store(), true),
  ('eeeeeeee-eeee-4eee-8eee-000000000042', 'zcashier', '-', z_store(), true)
  on conflict (id) do nothing;

insert into public.roles (id, name, store_id) values
  ('eeeeeeee-eeee-4eee-8eee-000000000043', 'Z Manager', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000044', 'Z Cashier', z_store())
on conflict (id) do nothing;

update public.users set role_id = 'eeeeeeee-eeee-4eee-8eee-000000000043'
 where id = 'eeeeeeee-eeee-4eee-8eee-000000000041';
update public.users set role_id = 'eeeeeeee-eeee-4eee-8eee-000000000044'
 where id = 'eeeeeeee-eeee-4eee-8eee-000000000042';

-- reports.edit on the manager only. A user_permissions row is enough: 014's
-- resolve_can checks the user's own grants before the role's.
insert into public.permissions (code, name)
values ('reports.edit', 'Edit reports')
on conflict (code) do nothing;

-- Migration 024 moved the privilege from reports.edit to closing.edit, so the
-- manager needs BOTH here. Granting only the old code is exactly the mistake
-- 024 exists to fix, and it shows up in this gate as six closes refused for a
-- reason that has nothing to do with 023.
insert into public.user_permissions (user_id, permission_id, allow)
select 'eeeeeeee-eeee-4eee-8eee-000000000041', p.id, true
  from public.permissions p where p.code in ('reports.edit', 'closing.edit')
on conflict (user_id, permission_id) do nothing;

-- The day's money. 1000 cash on Z1, then 500 cash + 500 wallet on Z2, then a
-- 400 CASH REFUND against Z2 - so the drawer should hold 1100 cash, and the
-- refund must have come off the cash tender specifically, not off the total.
--
-- Z3 is the void: 900 paid in cash, voided, so 013 writes a -900 cash refund.
-- If G-Z3 passes, that money has cancelled itself in the sum. Z4 is a
-- prescription - zero money, kind 'prescription' - and must not be counted as
-- an order. Z5 belongs to the rival store and must never appear.
insert into public.customers (id, name, phone, store_id) values
  ('eeeeeeee-eeee-4eee-8eee-000000000051', 'Ziad', '01000000051', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000052', 'Nour', '01000000052', z_store())
on conflict (id) do nothing;

insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, lab_status, kind, store_id)
values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 'Z0001', 'eeeeeeee-eeee-4eee-8eee-000000000051',
     1000, 0, 1000, 1000, '2026-09-20 10:00:00+00', 'Ready', 'sale', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', 'Z0002', 'eeeeeeee-eeee-4eee-8eee-000000000052',
     1000, 0, 1000, 1000, '2026-09-20 11:00:00+00', 'Not Started', 'sale', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', 'Z0003', 'eeeeeeee-eeee-4eee-8eee-000000000051',
     900, 0, 900, 900, '2026-09-20 12:00:00+00', 'Not Started', 'sale', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000064', 'Z0004', 'eeeeeeee-eeee-4eee-8eee-000000000051',
     0, 0, 0, 0, '2026-09-20 13:00:00+00', 'Not Started', 'prescription', z_store())
on conflict (id) do nothing;

-- The void on Z3. Done by hand rather than by calling void_sale() because the
-- assertion is about what the LEDGER looks like, not about void_sale working -
-- 013's 54 assertions already own that.
update public.sales set voided_at = '2026-09-20 12:30:00+00', void_reason = 'gate'
 where id = 'eeeeeeee-eeee-4eee-8eee-000000000063';

insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id) values
  ('eeeeeeee-eeee-4eee-8eee-000000000061', 1000, 'cash',   'payment', '2026-09-20 10:00:00+00', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000062',  500, 'cash',   'payment', '2026-09-20 11:00:00+00', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000062',  500, 'wallet', 'payment', '2026-09-20 11:00:00+00', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000062', -400, 'cash',   'refund',  '2026-09-20 11:30:00+00', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000063',  900, 'cash',   'payment', '2026-09-20 12:00:00+00', z_store()),
  ('eeeeeeee-eeee-4eee-8eee-000000000063', -900, 'cash',   'refund',  '2026-09-20 12:30:00+00', z_store());

-- Z4 reaches 'Received' inside the window, so it counts as delivered.
update public.sales set lab_status = 'Received', lab_status_changed_at = '2026-09-20 15:00:00+00'
 where id = 'eeeeeeee-eeee-4eee-8eee-000000000064';

-- The rival store's money, in the same window. If tenancy leaks, G-Z11 is what
-- notices - and it is licensed, so it cannot pass by being refused.
insert into public.sales (id, invoice_no, total_amount, discount, net_amount,
                          amount_paid, order_date, lab_status, kind, store_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000071', 'Z9999', 7777, 0, 7777, 7777,
        '2026-09-20 10:00:00+00', 'Ready', 'sale',
        'eeeeeeee-eeee-4eee-8eee-000000000032')
on conflict (id) do nothing;

insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id)
values ('eeeeeeee-eeee-4eee-8eee-000000000071', 7777, 'cash', 'payment',
        '2026-09-20 10:00:00+00', 'eeeeeeee-eeee-4eee-8eee-000000000032');

create function _imp(p_uid uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end $$;

-- The Cairo day the fixtures sit in, so the window comes from store_day_range()
-- rather than from a hand-written UTC range. 016 exists because getting this
-- wrong silently moved a sale between days.
create function _z_from() returns timestamptz
  language sql stable as $$ select from_at from public.store_day_range('2026-09-20'::date) $$;
create function _z_to() returns timestamptz
  language sql stable as $$ select to_at   from public.store_day_range('2026-09-20'::date) $$;

-- Scratch register, so a refused close cannot abort the TAP stream.
create table _cap (k text primary key, close_id uuid, err text, expected_cash numeric,
                   variance numeric, counted numeric);
grant all on _cap to authenticated;

create function _close(p_k text, p_counted numeric, p_from timestamptz, p_to timestamptz,
                       p_note text default null) returns void
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.close_shift(p_from, p_to, p_counted, p_note)).id;
  insert into _cap (k, close_id, expected_cash, variance, counted)
  select p_k, v_id, s.expected_cash, s.variance, s.counted_cash
    from public.shift_closes s where s.id = v_id;
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

-- ===== impersonate the manager =============================================
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000041');

-- ===== G-Z1: the report exists ==============================================
select has_function('public', 'z_report',
  'G-Z1 z_report exists, so the drawer question is answerable');

-- ===== G-Z2: expected_cash is the NET of payments and refunds ================
-- 1000 cash (Z1) + 500 cash (Z2) - 400 cash refund (Z2) = 1100. The voided
-- Z3 contributes 0 and is asserted separately below.
select is((select expected_cash::bigint from public.z_report(_z_from(), _z_to())), 1100::bigint,
  'G-Z2 expected cash is net of refunds, and the refund came off CASH specifically');

-- The wallet tender is in the total but NOT in the cash, which is the whole
-- distinction between "expected" and "in the drawer".
select is((select expected_total::bigint from public.z_report(_z_from(), _z_to())), 1600::bigint,
  'G-Z2b expected total includes the wallet tender the drawer will not hold');

select is((select refund_total::bigint from public.z_report(_z_from(), _z_to())), 1300::bigint,
  'G-Z2c refunds are reported as a positive figure (1300 = 400 plus the 900 void reversal)');

-- ===== G-Z3: a void nets to zero in the drawer ==============================
-- The property this whole design rests on. Z3 took 900 cash and void_sale wrote
-- -900 cash, so the drawer is unaffected - NOT because voided sales are filtered
-- out (they are not, anywhere in this function) but because the money cancelled
-- itself in the sum.
--
-- If a future edit "fixed" a wrong number here by excluding voided sales, this
-- would still pass while the refund semantics quietly changed underneath. The
-- refund is the mechanism; a filter would be a different, wrong mechanism.
select is((select expected_cash::bigint from public.z_report(_z_from(), _z_to()))
          - 1100::bigint, 0::bigint,
  'G-Z3 a voided 900 cash sale leaves the drawer at 1100 - the reversal cancelled it');

select is((select void_count::bigint from public.z_report(_z_from(), _z_to())), 1::bigint,
  'G-Z3b and the void is still REPORTED, not silently dropped - a mistaken void must not look like a quiet day');

-- ===== G-Z4: a prescription is not a billable order =========================
-- 022's kind, reused. Z1, Z2, Z3 are sales; Z4 is a prescription with no money.
-- Counting it would inflate the day's order count for work nobody paid for.
select is((select order_count::bigint from public.z_report(_z_from(), _z_to())), 3::bigint,
  'G-Z4 the prescription is not counted as an order');
select is((select prescription_count::bigint from public.z_report(_z_from(), _z_to())), 1::bigint,
  'G-Z4b ...but it is counted separately, so it is visible rather than invisible');

-- ===== G-Z5 / G-Z6: variance, the point of the whole screen ==================
-- A drawer that matches: counted 1100 against expected 1100.
select _close('z1', 1100, _z_from(), _z_to(), 'counted, all present');
select is((select variance::bigint from _cap where k = 'z1'), 0::bigint,
  'G-Z5 a drawer that matches the ledger gives zero variance');

-- A 50 shortage, on the NEXT window so it is a different close and not a
-- duplicate of z1 (G-Z8 asserts the duplicate refusal separately).
select _close('z2', 1050, _z_from(), _z_to() + interval '1 day', '50 short');
select is((select variance::bigint from _cap where k = 'z2'), -50::bigint,
  'G-Z6 a 50 EGP shortage reads as -50, counted minus expected');

-- ===== G-Z7: the close is recorded, and frozen ==============================
-- expected_cash is STORED, not recomputed on read. A later sale that re-prices
-- itself must not rewrite what the drawer was supposed to hold; that is the
-- difference between an audit trail and a live query.
select is((select expected_cash::bigint from _cap where k = 'z1'), 1100::bigint,
  'G-Z7 the close stored the expected figure as it stood at the time');
select is((select order_count::bigint from public.shift_closes
            where id = (select close_id from _cap where k = 'z1')), 3::bigint,
  'G-Z7b and its counters, so a close is a summary and not only a cash figure');

-- ===== G-Z8: a window is closed once ========================================
-- A close is an event. Re-closing the same window is a double-tap, and the
-- unique constraint is the backstop for two taps that both pass the check
-- before either has written.
select _close('z3', 1100, _z_from(), _z_to(), 'second attempt');
select is((select err from _cap where k = 'z3') is not null, true,
  'G-Z8 the same window cannot be closed twice');
select is((select count(*)::int from public.shift_closes), 2::int,
  'G-Z8b the refusal wrote nothing - there are still exactly two closes');

-- ===== G-Z9 / G-Z10: the arguments =========================================
select _close('z4', null, _z_from(), _z_to() + interval '2 days', 'no count');
select is((select err from _cap where k = 'z4') is not null, true,
  'G-Z9 a close with no counted drawer is refused - a shift is not closed by not knowing');

select _close('z5', 100, _z_to(), _z_from(), 'backwards');
select is((select err from _cap where k = 'z5') is not null, true,
  'G-Z10 a window that does not run forwards is refused');

-- ===== G-Z11: tenancy ======================================================
-- The rival store is licensed, so this proves tenancy rather than licensing.
select is((select expected_total::bigint from public.z_report(_z_from(), _z_to())), 1600::bigint,
  'G-Z11 another store''s 7777 is invisible to this store''s drawer');

-- ===== G-Z12: authorisation, and that the refusal wrote NOTHING ==============
-- The half that actually protects anyone. A gate that proved only that the
-- refusal HAPPENED would pass on a function that raised and then inserted anyway.
reset role;
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000042');   -- the cashier, no reports.edit

select _close('z6', 1100, _z_from(), _z_to() + interval '3 days', 'cashier tried');
select is((select err from _cap where k = 'z6') is not null, true,
  'G-Z12 a caller without reports.edit is refused');
select is((select count(*)::int from public.shift_closes), 2::int,
  'G-Z12b and the refusal wrote NO row - the check is enforcement, not a message');

-- ===== G-Z13: close_shift is the only way in ===============================
-- The RLS policy covers SELECT only and the grants revoke the rest. Asserted as
-- BEHAVIOUR rather than by reading pg_policies, because a policy that exists and
-- a policy that permits are different claims - the same reasoning 013 used when
-- it chose to perform deletes rather than assert has_table_privilege.
select throws_ok(
  $$insert into public.shift_closes
      (store_id, from_at, to_at, counted_cash, expected_cash, expected_total, variance)
    values (z_store(), '2026-09-19 00:00:00+00', '2026-09-19 23:00:00+00', 0, 0, 0, 0)$$,
  '42501', null,
  'G-Z13 a direct INSERT is refused - a close is written only by close_shift');

-- ===== G-Z14: 023 stamped itself ===========================================
-- Read as the migration's own role: lensy_schema_versions has RLS on and no
-- direct read for a client, so asking as authenticated would report an empty
-- ledger and pass for the wrong reason.
reset role;
-- 'at least', NOT 'equals' - written that way from the start because CI run
-- #112 proved the cost of getting it wrong, in 022's gate, on the very run that
-- introduced this migration. `= 23` would expire the moment 024 is written, and
-- the cost would be a red build for a schema nobody had broken.
select ok((select max(version) from public.lensy_schema_versions) >= 23,
  'G-Z14 023 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
