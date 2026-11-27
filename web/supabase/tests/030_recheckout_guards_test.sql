-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (re-checkout guards), run as an owner who holds every permission.
--
-- LEG: a legacy collapsed tender ('cash + instapay', from the 011 backfill or a
--      pre-030 re-checkout) passes the method check only because the ledger
--      already holds it. It may stay as it is or go down (a refund row), but it
--      may not take NEW money: z_report never counts it as drawer cash.
-- STL: the per-tender stale check. A History refund of 100 cash plus a
--      collection of 100 card leaves the total unchanged, so the
--      expected_amount_paid guard alone misses it and the re-checkout would
--      silently reverse both. expected_tenders catches it.
-- STK: a re-checkout that drops a product entirely puts its units back with
--      one 'sale' movement (the o-only side of the stock full join).
--
-- K10001: 2 x 500 = 1000, ledger 'cash + instapay' 500.
-- K10002: 2 x 500 = 1000, ledger cash 600 (what the client saw).
-- K10003: 1 x 500 frame + 2 x 300 lens = 1100, nothing paid.
begin;
create extension if not exists pgtap;
select plan(15);

insert into public.stores (id, name, time_zone)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000701', 'guard shop', 'Africa/Cairo')
on conflict (id) do nothing;
create function k_store() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000701'::uuid $$;
create function k_leg()   returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007c1'::uuid $$;
create function k_stl()   returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007c2'::uuid $$;
create function k_stk()   returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007c3'::uuid $$;
create function k_frame() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007d1'::uuid $$;
create function k_lens()  returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007d2'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (k_store(), 'STORE-K1', 'pro', null) on conflict (store_id) do nothing;
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1', 'kowner@t') on conflict do nothing;
insert into public.roles (id, name, store_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000007b1', 'k owner', k_store());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007b1', p.id
  from public.permissions p where p.code = any(public.supported_permissions());
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1', 'kowner', '-', k_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007b1', true);

insert into public.inventory (id, name, category, sale_price, cost_price, store_id) values
  (k_frame(), 'K Frame', 'Frame', 500, 200, k_store()),
  (k_lens(),  'K Lens',  'Lens',  300, 100, k_store());
insert into public.stock_movements (product_id, qty, type, note, store_id) values
  (k_frame(), 10, 'initial', 'seed', k_store()),
  (k_lens(),  10, 'initial', 'seed', k_store());

-- lab_status null: an exam-less re-checkout must not trip the lab.edit check
-- (the column DEFAULTs to 'Not Started', 000).
insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount,
                          amount_paid, payment_method, order_date, lab_status) values
  (k_leg(), k_store(), 'K10001', 'sale', 1000, 0, 1000, 0, 'Cash + InstaPay', now() - interval '1 day', null),
  (k_stl(), k_store(), 'K10002', 'sale', 1000, 0, 1000, 0, 'Cash',            now() - interval '1 day', null),
  (k_stk(), k_store(), 'K10003', 'sale', 1100, 0, 1100, 0, 'Cash',            now() - interval '1 day', null);
insert into public.sale_items (sale_id, store_id, product_id, qty, unit_price, total_price, name) values
  (k_leg(), k_store(), k_frame(), 2, 500, 1000, 'K Frame'),
  (k_stl(), k_store(), k_frame(), 2, 500, 1000, 'K Frame'),
  (k_stk(), k_store(), k_frame(), 1, 500,  500, 'K Frame'),
  (k_stk(), k_store(), k_lens(),  2, 300,  600, 'K Lens');
insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note) values
  (k_frame(), k_store(), -2, 'sale', 'K10001', 'POS Sale: K10001'),
  (k_frame(), k_store(), -2, 'sale', 'K10002', 'POS Sale: K10002'),
  (k_frame(), k_store(), -1, 'sale', 'K10003', 'POS Sale: K10003'),
  (k_lens(),  k_store(), -2, 'sale', 'K10003', 'POS Sale: K10003');
insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by) values
  (k_leg(), 500, 'cash + instapay', 'payment', k_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1'),
  (k_stl(), 600, 'cash',            'payment', k_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1');

-- re-checkout of the unchanged 2 x 500 cart with the given header and tenders
create function _rc(p_id uuid, p_sale jsonb, p_payments jsonb) returns public.sales language sql as $$
  select public.update_sale_order(p_id, p_sale,
    '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000007d1","qty":2,"unit_price":500,"total_price":1000,"name":"K Frame"}]'::jsonb,
    '[]'::jsonb, p_payments) $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1', false);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-0000000007a1"}', false);

-- ---------------------------------------------------------------- LEG
select lives_ok($$ select _rc(k_leg(), '{"net_amount":1000}', '[{"method":"cash + instapay","amount":500}]') $$,
  'LEG1 keeping the legacy tender at 500 re-checks out');
select is((select array[count(*), sum(amount)] from public.sale_payments where sale_id = k_leg()),
  array[1::numeric, 500::numeric], 'LEG2 ... and appends nothing');
select throws_ok($$ select _rc(k_leg(), '{"net_amount":1000}', '[{"method":"cash + instapay","amount":1000}]') $$,
  'P0001', 'Invalid payment method', 'LEG3 raising the legacy tender to 1000 (new money on it) is refused');
select lives_ok($$ select _rc(k_leg(), '{"net_amount":1000}',
                   '[{"method":"cash + instapay","amount":300},{"method":"cash","amount":200}]') $$,
  'LEG4 moving 200 off the legacy tender onto cash at the same total succeeds (history.refund held)');
select is((select array[count(*), sum(amount)] from public.sale_payments
            where sale_id = k_leg() and kind = 'refund' and method = 'cash + instapay'),
  array[1::numeric, -200::numeric], 'LEG5 ... as one -200 refund row on the legacy tender');
select is((select array[sum(amount) filter (where method = 'cash + instapay'), sum(amount) filter (where method = 'cash')]
             from public.sale_payments where sale_id = k_leg()),
  array[300::numeric, 200::numeric], 'LEG6 ... and the ledger holds 300 legacy + 200 cash');

-- ---------------------------------------------------------------- STL
-- The client opened K10002 seeing [cash 600]. Meanwhile History refunded 100
-- cash and collected 100 on card: the total is still 600.
select public.refund_sale(k_stl(), 100, 'cash', 'overcharge');
select public.collect_sale_payment(k_stl(), '[{"method":"card","amount":100}]');
select throws_like($$ select _rc(k_stl(),
                     '{"net_amount":1000,"expected_amount_paid":600,"expected_tenders":[{"method":"cash","amount":600}]}',
                     '[{"method":"cash","amount":600}]') $$,
  'invoice changed since it was opened%', 'STL1 same total, different tenders: the stale client is refused');
select is((select array[count(*), sum(amount)] from public.sale_payments where sale_id = k_stl()),
  array[3::numeric, 600::numeric], 'STL2 ... and the refund and the collection are not reversed');
-- Method case/whitespace and a split line are normalised like the client does;
-- a method that nets to 0 is ignored.
select lives_ok($$ select _rc(k_stl(),
                   '{"net_amount":1000,"expected_amount_paid":600,"expected_tenders":[{"method":"Cash ","amount":300},{"method":"cash","amount":200},{"method":"card","amount":100},{"method":"wallet","amount":0}]}',
                   '[{"method":"cash","amount":500},{"method":"card","amount":100}]') $$,
  'STL3 the tenders the client saw match the ledger: the re-checkout proceeds');
select is((select count(*) from public.sale_payments where sale_id = k_stl()), 3::bigint,
  'STL4 ... and appends nothing');
-- card refunded in full nets to 0 on the ledger, so a client that no longer
-- lists it is current.
select public.refund_sale(k_stl(), 100, 'card', 'customer paid cash instead');
select lives_ok($$ select _rc(k_stl(),
                   '{"net_amount":1000,"expected_tenders":[{"method":"cash","amount":500}]}',
                   '[{"method":"cash","amount":500}]') $$,
  'STL5 a ledger method that nets to 0 does not count as a tender the client missed');

-- ---------------------------------------------------------------- STK
select lives_ok($$ select public.update_sale_order(k_stk(), '{"net_amount":500}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000007d1","qty":1,"unit_price":500,"total_price":500,"name":"K Frame"}]',
  '[]', '[]') $$,
  'STK1 a re-checkout that drops the lens entirely succeeds');
select is((select array[count(*), sum(qty)] from public.stock_movements
            where ref_no = 'K10003' and store_id = k_store() and type = 'sale' and product_id = k_lens()
              and note like 'POS Re-checkout%'),
  array[1::bigint, 2::bigint], 'STK2 ... one sale movement puts the 2 lenses back');
select is((select count(*) from public.stock_movements
            where ref_no = 'K10003' and store_id = k_store() and product_id = k_frame()
              and note like 'POS Re-checkout%'),
  0::bigint, 'STK3 ... and the unchanged frame gets none');
select is((select stock_qty from public.inventory where id = k_lens()), 10,
  'STK4 ... so the lens shelf is back to 10');

select * from finish();
rollback;
