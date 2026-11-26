-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (H1/H2): a re-checkout reconciles the payment ledger and the stock
-- movements by APPENDING deltas. It never deletes a refund row, never re-dates
-- a payment or a sale movement, refuses a tender it does not know, and an
-- unchanged cart re-checks out even when the shelf is empty. Money going back
-- is never guessed onto a tender: a lower total is refused with 'refund first'.
--
-- Day 1: H10001 sold 2 x 500, paid 600 cash + 400 instapay.
-- Day 2: 100 cash refunded with refund_sale (the -100 'refund' row below).
begin;
create extension if not exists pgtap;
select plan(17);

insert into public.stores (id, name, time_zone)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'h1 shop', 'Africa/Cairo')
on conflict (id) do nothing;
create function h_store() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301'::uuid $$;
create function h_sale()  returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1'::uuid $$;
create function h_prod()  returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (h_store(), 'STORE-H1', 'pro', null) on conflict (store_id) do nothing;
insert into auth.users (id, email, username)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', 'h1boss@lensypos.local', 'h1boss') on conflict do nothing;
insert into public.roles (id, name, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1', 'h1 owner', h_store());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1', p.id
  from public.permissions p where p.code = any(public.supported_permissions())
on conflict do nothing;
insert into public.users (id, username, password_hash, store_id, role_id, is_active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', 'h1boss', '-', h_store(),
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1', true);

insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values (h_prod(), 'H1 Frame', 'Frame', 500, 200, h_store());
insert into public.stock_movements (product_id, qty, type, note, store_id)
values (h_prod(), 10, 'initial', 'seed', h_store());

insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount,
                          amount_paid, payment_method, order_date)
values (h_sale(), h_store(), 'H10001', 'sale', 1000, 0, 1000, 0, 'Cash + InstaPay', '2026-01-01 10:00+02');
insert into public.sale_items (sale_id, store_id, product_id, qty, unit_price, total_price, name)
values (h_sale(), h_store(), h_prod(), 2, 500, 1000, 'H1 Frame');
insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note, created_at)
values (h_prod(), h_store(), -2, 'sale', 'H10001', 'POS Sale: H10001', '2026-01-01 10:00+02');
insert into public.sale_payments (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by) values
  (h_sale(),  600, 'cash',     'payment', null, '2026-01-01 10:00+02', h_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1'),
  (h_sale(),  400, 'instapay', 'payment', null, '2026-01-01 10:00+02', h_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1'),
  (h_sale(), -100, 'cash',     'refund', 'Refund H10001: overcharge', '2026-01-02 12:00+02', h_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1');

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', false);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1"}', false);

-- H1a: a re-checkout that only changes the delivery date, sending the true per-method tenders
select lives_ok($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1',
  '{"net_amount":1000,"delivery_date":"2026-01-10","expected_amount_paid":900}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":2,"unit_price":500,"total_price":1000,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":500},{"method":"instapay","amount":400}]') $$,
  'H1a unchanged re-checkout succeeds');
select is((select count(*) from public.sale_payments where sale_id = h_sale()), 3::bigint,
  'H1b ledger rows are not deleted or re-inserted');
select is((select note from public.sale_payments where sale_id = h_sale() and kind = 'refund'),
  'Refund H10001: overcharge', 'H1c the refund row and its reason survive');
select is((select min(paid_at) from public.sale_payments where sale_id = h_sale()),
  '2026-01-01 10:00+02'::timestamptz, 'H1d original paid_at is kept');
select is((select expected_total from public.z_report('2026-01-01 00:00+02', '2026-01-02 00:00+02')),
  1000::numeric, 'H1e day-1 Z total still 1000');
select is((select created_at from public.stock_movements
            where ref_no = 'H10001' and type = 'sale' order by created_at limit 1),
  '2026-01-01 10:00+02'::timestamptz, 'H2a the sale movement is not re-dated');
select is((select stock_qty from public.inventory where id = h_prod()), 8,
  'H2b stock unchanged by an unchanged re-checkout');

-- H1i: a client that opened the invoice before a later payment/refund is told to
-- reload instead of overwriting the ledger it never saw
select throws_like($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1',
  '{"net_amount":1000,"expected_amount_paid":1000}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":2,"unit_price":500,"total_price":1000,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":600},{"method":"instapay","amount":400}]') $$,
  '%invoice changed since it was opened%', 'H1i a stale client (expected_amount_paid differs) is refused');

-- H1f: the collapsed tender loadSale used to send is refused
select throws_like($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1', '{"net_amount":1000}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":2,"unit_price":500,"total_price":1000,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash + instapay","amount":900}]') $$,
  '%payment method%', 'H1f an unknown tender is refused');

-- H1g: dropping one frame (net 500) while 900 is held means 400 goes back.
-- The client trimmed its tenders to [cash 500]; reconciling to that would book
-- the refund on cash -0 / instapay -400 by the order the lines happened to be
-- in, not by what left the drawer. It is refused: refund first.
select throws_like($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1', '{"net_amount":500}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":1,"unit_price":500,"total_price":500,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":500}]') $$,
  'refund first:%', 'H1g a re-checkout that gives money back is refused: refund first');
select is((select array[count(*), sum(amount)] from public.sale_payments where sale_id = h_sale()),
  array[3::numeric, 900::numeric], 'H1h ... and the ledger is untouched');

-- H1j: the cashier records the refund on the tender it really went back on,
-- with a reason (refund_sale, 028), reopens the invoice and re-checks out.
select lives_ok($$ select public.refund_sale('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1', 400, 'instapay', 'frame returned') $$,
  'H1j the refund is recorded from History on the tender the cashier chose');
select lives_ok($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1',
  '{"net_amount":500,"expected_amount_paid":500}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":1,"unit_price":500,"total_price":500,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":500}]') $$,
  'H1k the reopened invoice re-checks out at net 500');
select is((select array[count(*) filter (where kind = 'payment'), count(*) filter (where kind = 'refund'), sum(amount)]
             from public.sale_payments where sale_id = h_sale()),
  array[2::numeric, 2::numeric, 500::numeric], 'H1l originals and both refunds kept, nothing appended by the re-checkout; sum 500');
select is((select sum(amount) from public.sale_payments where sale_id = h_sale() and method = 'instapay'),
  0::numeric, 'H1m the 400 went back on instapay, as the cashier recorded it');

-- H2c/H2d: a store that forbids negative stock, with the shelf at 0. The
-- unchanged cart must re-checkout (it takes nothing new off the shelf); adding
-- a unit must still be refused.
reset role;
insert into public.stock_movements (product_id, qty, type, note, store_id)
select h_prod(), -stock_qty, 'adjustment', 'empty the shelf', h_store()
  from public.inventory where id = h_prod();
update public.stores set allow_negative_stock = false where id = h_store();
set role authenticated;
select lives_ok($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1', '{"net_amount":500}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":1,"unit_price":500,"total_price":500,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":500}]') $$,
  'H2c no negative stock allowed, shelf at 0: an unchanged re-checkout still succeeds');
select throws_like($$ select public.update_sale_order('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1', '{"net_amount":1000}',
  '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000003d1","qty":2,"unit_price":500,"total_price":1000,"name":"H1 Frame"}]',
  '[]', '[{"method":"cash","amount":500}]') $$,
  '%insufficient stock%', 'H2d ... but taking one more unit off an empty shelf is refused');

select * from finish();
rollback;
