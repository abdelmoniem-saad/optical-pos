-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (re-checkout and money going back), run as a CLERK who holds
-- pos.edit but not history.refund, and as an owner who holds everything.
--
--   * an unchanged or higher tender list re-checks out without history.refund;
--   * moving money from one tender to another at the same total writes a
--     refund row on the tender that went down, so it needs history.refund
--     (42501) - removing that require_perm turns G-R3 red;
--   * a lower total is never reconciled by the server, whoever asks: it is
--     'refund first' (the tender and reason are chosen in refund_sale).
--
-- R1: 2 x 500 = 1000, 600 cash paid.
begin;
create extension if not exists pgtap;
select plan(9);

insert into public.stores (id, name, time_zone)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000601', 'gate shop', 'Africa/Cairo')
on conflict (id) do nothing;
create function g_store() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000601'::uuid $$;
create function g_sale()  returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006c1'::uuid $$;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (g_store(), 'STORE-G1', 'pro', null) on conflict (store_id) do nothing;
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a1', 'gowner@t'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a2', 'gclerk@t') on conflict do nothing;
insert into public.roles (id, name, store_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006b1', 'g owner', g_store()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006b2', 'g clerk', g_store());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006b1', p.id
  from public.permissions p where p.code = any(public.supported_permissions());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006b2', p.id
  from public.permissions p where p.code in ('pos.view', 'pos.create', 'pos.edit');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a1', 'gowner', '-', g_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006b1', true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a2', 'gclerk', '-', g_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006b2', true);

insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006d1', 'G Frame', 'Frame', 500, 200, g_store());
-- lab_status is null as create_sale_order stores it for an exam-less sale: the
-- column DEFAULTs to 'Not Started' (000), and an exam-less re-checkout clearing
-- that would need lab.edit, which the clerk does not hold - a refusal that has
-- nothing to do with the money under test.
insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount,
                          amount_paid, payment_method, order_date, lab_status)
values (g_sale(), g_store(), 'G10001', 'sale', 1000, 0, 1000, 0, 'Cash', now(), null);
insert into public.sale_items (sale_id, store_id, product_id, qty, unit_price, total_price, name)
values (g_sale(), g_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006d1', 2, 500, 1000, 'G Frame');
insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000006d1', g_store(), -2, 'sale', 'G10001', 'POS Sale: G10001');
insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by)
values (g_sale(), 600, 'cash', 'payment', g_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000006a1');

-- re-checkout of the unchanged cart (2 x 500, net 1000) with the given tenders
create function _rc(p_payments jsonb) returns public.sales language sql as $$
  select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000006c1', '{"net_amount":1000}'::jsonb,
    '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000006d1","qty":2,"unit_price":500,"total_price":1000,"name":"G Frame"}]'::jsonb,
    '[]'::jsonb, p_payments) $$;
create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p)::text, true);
end $$;

set role authenticated;
select _as('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a2'); -- the clerk

select lives_ok($$ select _rc('[{"method":"cash","amount":600}]') $$,
  'G-R1 clerk: an unchanged tender list re-checks out without history.refund');
select lives_ok($$ select _rc('[{"method":"cash","amount":600},{"method":"card","amount":200}]') $$,
  'G-R2 clerk: collecting 200 more on card needs no history.refund');
select throws_ok($$ select _rc('[{"method":"cash","amount":400},{"method":"card","amount":400}]') $$,
  '42501', 'insufficient permission: history.refund',
  'G-R3 clerk: moving 200 from cash to card (a refund on cash) needs history.refund');
select throws_like($$ select _rc('[{"method":"cash","amount":600}]') $$,
  'refund first:%', 'G-R4 clerk: a lower total is refused - refund first');
select is((select array[count(*), sum(amount)] from public.sale_payments where sale_id = g_sale()),
  array[2::numeric, 800::numeric], 'G-R5 the refused re-checkouts wrote nothing (600 cash + 200 card)');

select _as('aaaaaaaa-aaaa-4aaa-8aaa-0000000006a1'); -- the owner
select throws_like($$ select _rc('[{"method":"card","amount":200}]') $$,
  'refund first:%', 'G-R6 owner: holding every permission does not let the server pick refund tenders');
select lives_ok($$ select _rc('[{"method":"cash","amount":400},{"method":"card","amount":400}]') $$,
  'G-R7 owner: the cash -> card move is allowed with history.refund');
select is((select amount from public.sale_payments where sale_id = g_sale() and kind = 'refund'),
  -200::numeric, 'G-R8 ... as a 200 refund row on cash');
select is((select array[sum(amount) filter (where method = 'cash'), sum(amount) filter (where method = 'card')]
             from public.sale_payments where sale_id = g_sale()),
  array[400::numeric, 400::numeric], 'G-R9 ... and the ledger holds 400 cash + 400 card');

select * from finish();
rollback;
