-- ===========================================================================
-- 028 - a partial refund on a live invoice.
--
-- WHY THIS GATE EXISTS. void_sale reverses a WHOLE sale. This is the other
-- case - "give some money back, keep the invoice" - and it did not exist, so a
-- shop's only recourse was to void a correct invoice and re-key it. The gate
-- proves the refund is partial (the sale stays, only money moves), that the
-- ceiling is PER-TENDER (the assertion that matters: you cannot refund 500
-- cash on a 300-cash sale), and that the permission is its own code.
--
-- G-R5 is the load-bearing one: it refuses a refund that exceeds what was paid
-- ON THAT METHOD, which a total-sale check would wave through. G-R6 proves the
-- refusal wrote NOTHING - a gate that only proved "refused" passes against a
-- function that raises and then inserts anyway (013's argument).
-- ===========================================================================
begin;
create extension if not exists pgtap;

-- 11. Derived from the assertions below rather than remembered.
select plan(11);

-- ===== fixtures ==============================================================
insert into public.stores (id, name, time_zone) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000091', 'r shop', 'Africa/Cairo')
on conflict (id) do nothing;

create function r_store() returns uuid
  language sql stable as $$
  select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000091'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (r_store(), 'STORE-R', 'pro', null)
on conflict (store_id) do nothing;

-- A manager who holds history.void (so the seed grants history.refund), a
-- cashier who holds NEITHER. (The customer is a separate table - see below.)
insert into auth.users (id, email, username) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1', 'rboss@lensypos.local',  'rboss'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2', 'rcash@lensypos.local',  'rcash')
on conflict (id) do nothing;

-- A role that holds history.void - the seed copies history.refund onto it.
-- store_id is required (008 made roles.store_id NOT NULL) and must be the
-- caller's store, or the tenant RLS on role_permissions would hide the grant.
insert into public.roles (id, name, store_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000b1', 'r manager', r_store())
on conflict (id) do nothing;

insert into public.permissions (code, name)
values ('history.void', 'Void a sale')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000b1'::uuid, p.id
  from public.permissions p where p.code = 'history.void'
on conflict (role_id, permission_id) do nothing;

insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1', 'rboss', '-', r_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000b1', true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2', 'rcash', '-', r_store(), null, true)
on conflict (id) do nothing;

-- sales.customer_id references public.customers, NOT public.users - so the
-- customer is its own row. (The third auth identity rcust is unnecessary for
-- this gate; dropped rather than pointed at the wrong table.)
insert into public.customers (id, name, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a3', 'r customer', r_store())
on conflict (id) do nothing;

-- Seed AFTER the fixtures exist (024's whole point: migration-time seeding has
-- nothing to act on, the seed function is what a gate can actually call).
select public.seed_refund_permission();

create function _imp(p_uid uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text)::text, false);
end $$;

-- Wrap the refund so the returned row does not print as a stray result line in
-- the TAP stream (the way 013 wraps void_sale in a helper). perform is legal
-- here, inside plpgsql, where it is not at the top level of the script.
create function _refund(p_id uuid, p_amt numeric, p_method text, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.refund_sale(p_id, p_amt, p_method, p_reason);
end $$;

-- A live sale, paid 300 cash + 400 wallet = 700. The per-tender split is what
-- G-R5 tests, so the two tenders must differ.
create function r_sale() returns uuid
  language sql stable as $$
  select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1'::uuid $$;

insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount,
                          net_amount, amount_paid, payment_method, user_id, customer_id)
values (r_sale(), r_store(), 'R0001', 'sale', 700, 0, 700, 700, 'cash',
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a3');

insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by)
values (r_sale(), 300, 'cash',   'payment', r_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1'),
       (r_sale(), 400, 'wallet', 'payment', r_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1');

-- ===== 1) the RPC exists, signature-exact ===================================
-- to_regprocedure, not has_function: has_function PERFORMS a test and returns
-- its TAP line (text), so wrapping it in is() types as is(text, boolean,
-- unknown) - 026's lesson.
select is((to_regprocedure('public.refund_sale(uuid, numeric, text, text)') is not null), true,
  'G-R1 refund_sale(uuid, numeric, text, text) exists - a live sale can be partly refunded');

-- ===== 2) the permission was seeded to the void-holder ======================
-- The seed is what makes the feature not-dead: rboss holds history.void, so
-- history.refund must have been copied on. Read as the manager.
set role authenticated;
select _imp('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1'::uuid);

select is(public.resolve_can('history.refund'), true,
  'G-R2 the seed granted history.refund to the history.void holder - not a dead permission');

-- A cashier who holds neither is refused. This is the permission gate.
select _imp('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2'::uuid);
select throws_ok(
  $$ select public.refund_sale('aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1'::uuid, 50, 'cash') $$,
  '42501', 'insufficient permission: history.refund',
  'G-R3 a caller without history.refund is refused, naming the code');

-- ===== 3) a valid partial refund: sale stays, only money moves ==============
select _imp('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1'::uuid);

-- Actually perform the refund of 100 of the 300 cash. (The call must be made
-- here as the manager; asserting the effect without performing it would test
-- nothing - the first draft did exactly that and every assertion below read
-- the untouched fixture.)
select _refund(r_sale(), 100, 'cash', 'overcharge');

-- The sale must NOT be voided, and amount_paid must drop to 600 (700 - 100),
-- recomputed by the 013 sync trigger - not written by refund_sale itself.
select is((
  select amount_paid from public.sales where id = r_sale()
), 600::numeric,
  'G-R4 a 100 cash refund drops amount_paid to 600 - the header follows the ledger');

select is((
  select voided_at is null from public.sales where id = r_sale()
), true,
  'G-R4b ...and the sale is NOT voided - a refund is not a void, the invoice stays');

-- The refund row itself: negative, kind refund, on the named method.
select is((
  select amount from public.sale_payments
   where sale_id = r_sale() and kind = 'refund' and method = 'cash'
), -100::numeric,
  'G-R4c the refund is a NEGATIVE cash row, so cash-up per tender stays truthful');

-- ===== 4) THE CEILING, PER TENDER ===========================================
-- G-R5. THE ASSERTION THAT MATTERS. 300 cash was paid and 100 already refunded,
-- so 200 cash remains. Refunding 500 'cash' must be refused. A total-sale
-- ceiling would compare 500 against the sale's remaining total (600) and wave
-- it through - refunding 500 cash on a sale that only ever took 300 cash. The
-- per-tender guard is what stops that over-refund. (numeric renders at scale 2,
-- so the message reads 200.00, not 200 - the DB's spelling, asserted exactly.)
select throws_ok(
  $$ select public.refund_sale('aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1'::uuid, 500, 'cash') $$,
  '22023', 'refund of 500 exceeds the 200.00 paid on cash',
  'G-R5 refunding more CASH than was paid in cash is refused - the ceiling is per-tender');

-- G-R6. The refusal wrote NOTHING: still exactly one refund row, amount_paid
-- still 600. A gate that only proved "refused" passes against a function that
-- raises and then inserts anyway (013's argument).
select is((
  select count(*)::int from public.sale_payments
   where sale_id = r_sale() and kind = 'refund'
), 1,
  'G-R6 the refused refund wrote no row - the check is enforcement, not a message');

select is((
  select amount_paid from public.sales where id = r_sale()
), 600::numeric,
  'G-R6b ...and amount_paid is unmoved, so the header did not drift on a refusal');

-- ===== 5) a voided sale is not refundable ===================================
reset role;
update public.sales set voided_at = now() where id = r_sale();
set role authenticated;
select _imp('aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1'::uuid);

select throws_ok(
  $$ select public.refund_sale('aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1'::uuid, 10, 'wallet') $$,
  'P0001', 'sale is already voided',
  'G-R7 a voided sale is not refundable - void_sale already returned the money');

-- ===== 6) 028 recorded itself ==============================================
reset role;
select is((exists (select 1 from public.lensy_schema_versions where version = 28)), true,
  'G-R8 028 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;

