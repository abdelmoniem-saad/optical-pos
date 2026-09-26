-- LensyPOS — Phase 1 gate: 012_integrity_test.sql (pgTAP)
-- ============================================================
-- Proves PHASED_ROADMAP §4's five gates against a database built from
-- 000…012 by scripts/test-db.sh:
--   G1 tampered totals are rejected (lines re-priced from the catalog)
--   G2 oversell is rejected when the store forbids it (allowed by default —
--      stores.allow_negative_stock keeps today's intentional workflow)
--   G3 invoice numbers come from the atomic counter (two draws, two numbers)
--   G4 double-submit with the same key creates exactly one sale
--   G5 inventory.stock_qty equals sum(stock_movements) on the seeded dataset
-- plus: negotiated / round-up / free totals survive exactly, payment > net is
-- rejected, qty <= 0 is rejected, add_inventory_item is atomic.
--
-- Everything runs inside ONE transaction and ROLLS BACK: the database is left
-- exactly as it was. Runs as the `authenticated` role with a JWT claim set, so
-- RLS + the security-invoker RPC are exercised for real.
--
-- Honest limitation: pgTAP is single-connection, so G3 is asserted as two
-- sequential atomic draws (the race itself is closed by the counter row lock
-- plus sales.invoice_no's unique constraint, which the conflict path covers).
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(26);

-- ===== seed (superuser; RLS bypassed for SETUP only) ========================
-- 008 auto-creates 'Main Store' and 009 licenses it (perpetual pro), so the
-- tenant + license RLS policies are satisfied for the cashier below.

create function test_store_id() returns uuid
language sql stable as $$
  select id from public.stores order by created_at limit 1
$$;

insert into auth.users (id, email, username)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier@lensypos.local', 'cashier');

insert into public.users (id, username, password_hash, full_name, store_id, is_active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier', '-', 'Cashier',
        test_store_id(), true);

insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 'Test Lens A',  'Lens',  500.00, 200.00, test_store_id()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000002', 'Test Frame B', 'Frame', 100.00,  40.00, test_store_id()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000003', 'Test Frame C', 'Frame',  80.00,  30.00, test_store_id());

-- Test Lens A starts with 5 on the shelf (fires the 012 stock_qty trigger);
-- Frame B / Frame C start at 0 (no movements = the oversell scenarios).
insert into public.stock_movements (product_id, qty, type, note, store_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 5, 'initial', 'seed', test_store_id());

-- Scratch register: every checkout's outcome (sale id or caught error) lands
-- here so ONE rejected call cannot abort the whole TAP stream.
create table _cap (k text primary key, sale_id uuid, note text, err text);
grant all on _cap to authenticated;

create function _checkout(
  p_k        text,
  p_sale     jsonb,
  p_items    jsonb,
  p_exams    jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb,
  p_key      uuid  default null
) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  v_id := (public.create_sale_order(p_sale, p_items, p_exams, p_payments, p_key)).id;
  insert into _cap (k, sale_id) values (p_k, v_id);
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

-- 'total|discount|net|amount_paid' of the checkout recorded under p_k.
create function _hdr(p_k text) returns text
language sql stable as $$
  select to_char(s.total_amount, 'FM999999990.00') || '|'
      || to_char(s.discount,     'FM999999990.00') || '|'
      || to_char(s.net_amount,   'FM999999990.00') || '|'
      || to_char(s.amount_paid,  'FM999999990.00')
    from public.sales s
    join _cap c on c.sale_id = s.id
   where c.k = p_k
$$;

-- ===== impersonate the signed-in cashier =====================================
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
  perform set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001"}', false);
end $$;

-- ---------- G1: server re-pricing ------------------------------------------
-- T1 normal checkout at catalog prices succeeds.
select _checkout('t1',
  '{"total_amount": 1000, "discount": 0, "net_amount": 1000, "amount_paid": 1000, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 1000}]'::jsonb);
select is((select err from _cap where k = 't1'), null,
  'T1 checkout with catalog prices succeeds');

-- T2 the stored line is exactly qty x catalog price.
select is(
  (select si.unit_price from public.sale_items si
    where si.sale_id = (select sale_id from _cap where k = 't1')
      and si.name = 'Test Lens A'),
  500::numeric, 'T2 line stored at the catalog price');

-- T3 header totals + ledger-driven amount_paid.
select is(_hdr('t1'), '1000.00|0.00|1000.00|1000.00',
  'T3 header totals recomputed, amount_paid from the ledger');

-- T4 negotiated total below the catalog sum: the browser claims gross 800
-- (the cart's grossOverride flow) — the DB keeps lines at catalog price and
-- stores the 200 gap as an explicit discount. Net is preserved EXACTLY.
select _checkout('t4',
  '{"total_amount": 800, "discount": 0, "net_amount": 800, "amount_paid": 0}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A"}]'::jsonb);
select is(_hdr('t4'), '1000.00|200.00|800.00|0.00',
  'T4 negotiated net survives; the gap becomes an explicit discount');

-- T5 round-up above the catalog sum (typed gross > items total).
select _checkout('t5',
  '{"total_amount": 1200, "discount": 0, "net_amount": 1200, "amount_paid": 1200}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 1200}]'::jsonb);
select is(_hdr('t5'), '1200.00|0.00|1200.00|1200.00',
  'T5 round-up total is preserved (store-favouring)');

-- T6 free order: net 0 on a 500 catalog sum = 100% discount, nothing paid.
select _checkout('t6',
  '{"total_amount": 0, "discount": 0, "net_amount": 0, "amount_paid": 0}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb);
select is(_hdr('t6'), '500.00|500.00|0.00|0.00',
  'T6 free order stores a full discount, net 0');

-- T7 tampered line price (1 instead of 500) is rejected outright.
select _checkout('t7',
  '{"total_amount": 1, "discount": 0, "net_amount": 1, "amount_paid": 1}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 1, "total_price": 1, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 1}]'::jsonb);
select is((select err from _cap where k = 't7'), 'price changed: Test Lens A',
  'T7 tampered line price is rejected (G1)');
select is(
  (select count(*) from public.sales
    where id = (select sale_id from _cap where k = 't7')),
  0::bigint, 'T7b a rejected checkout writes nothing');

-- T8 qty <= 0 rejected.
select _checkout('t8',
  '{"total_amount": 0, "discount": 0, "net_amount": 0, "amount_paid": 0}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 0, "unit_price": 500, "total_price": 0, "name": "Test Lens A"}]'::jsonb);
select is((select err from _cap where k = 't8'), 'invalid line quantity',
  'T8 zero/negative quantities are rejected');

-- T9 money in > money out rejected (header or ledger).
select _checkout('t9',
  '{"total_amount": 100, "discount": 0, "net_amount": 100, "amount_paid": 500}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 500}]'::jsonb);
select is((select err from _cap where k = 't9'), 'payment exceeds net amount',
  'T9 payments may never exceed the net amount');

-- T10 unknown product rejected before anything is written.
select _checkout('t10',
  '{"total_amount": 500, "discount": 0, "net_amount": 500, "amount_paid": 500}'::jsonb,
  '[{"product_id": "99999999-9999-4999-8999-999999999999", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Ghost"}]'::jsonb);
select is((select err from _cap where k = 't10'), 'unknown product in cart',
  'T10 an unknown product is rejected');

-- T11 negative net rejected.
select _checkout('t11',
  '{"total_amount": -5, "discount": 0, "net_amount": -5, "amount_paid": 0}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb);
select is((select err from _cap where k = 't11'), 'negative net amount',
  'T11 a negative net amount is rejected');

-- ---------- G2: stock guard ------------------------------------------------
-- T12 stores.allow_negative_stock defaults to TRUE: Frame B has 0 on the
-- shelf and the sale still goes through (today's intentional workflow),
-- taking the stock to -1.
select _checkout('t12',
  '{"total_amount": 100, "discount": 0, "net_amount": 100, "amount_paid": 100}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000002", "qty": 1, "unit_price": 100, "total_price": 100, "name": "Test Frame B"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 100}]'::jsonb);
select is((select err from _cap where k = 't12'), null,
  'T12a overselling is ALLOWED by default (per-store switch, default on)');
select is(
  (select stock_qty from public.inventory
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'),
  (-1)::integer, 'T12b stock went to -1 and the read model followed');

-- T13 flip the store's switch (superuser, like the platform page would):
-- Frame C at 0 must now be refused, atomically, with the product named.
reset role;
update public.stores
   set allow_negative_stock = false
 where id = (select id from public.stores order by created_at limit 1);
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
end $$;
select _checkout('t13',
  '{"total_amount": 80, "discount": 0, "net_amount": 80, "amount_paid": 80}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000003", "qty": 1, "unit_price": 80, "total_price": 80, "name": "Test Frame C"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 80}]'::jsonb);
select is((select err from _cap where k = 't13'), 'insufficient stock: Test Frame C',
  'T13 with the switch OFF an oversell is rejected (G2)');
reset role;
update public.stores
   set allow_negative_stock = true
 where id = (select id from public.stores order by created_at limit 1);
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
end $$;

-- ---------- G3: atomic invoice numbers -------------------------------------
insert into _cap (k, note) values ('inv1', public.next_invoice_no());
insert into _cap (k, note) values ('inv2', public.next_invoice_no());
select isnt((select note from _cap where k = 'inv1'),
            (select note from _cap where k = 'inv2'),
  'G3 two counter draws yield two different invoice numbers');
select ok(
  (select note from _cap where k = 'inv1') ~ '^[0-9]{6}$'
  and (select note from _cap where k = 'inv2') ~ '^[0-9]{6}$',
  'G3b drawn numbers keep the zero-padded 6-digit format');

-- ---------- G4: idempotent checkout ----------------------------------------
select _checkout('idem1',
  '{"total_amount": 777, "discount": 0, "net_amount": 777, "amount_paid": 777, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 777}]'::jsonb,
  '44444444-4444-4444-8444-000000000001'::uuid);
select _checkout('idem2',
  '{"total_amount": 777, "discount": 0, "net_amount": 777, "amount_paid": 777, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 777}]'::jsonb,
  '44444444-4444-4444-8444-000000000001'::uuid);
select ok(
  (select sale_id from _cap where k = 'idem1') is not null
  and (select sale_id from _cap where k = 'idem1')
    = (select sale_id from _cap where k = 'idem2'),
  'G4 replaying the same key returns the SAME sale');
select is(
  (select count(*) from public.sales
    where idempotency_key = '44444444-4444-4444-8444-000000000001'),
  1::bigint, 'G4b exactly one sale exists for the idempotency key');
select is((select err from _cap where k = 'idem2'), null,
  'G4c the replay does not error');

-- ---------- G5: stock read model mirrors the ledger ------------------------
select is(
  (select stock_qty::numeric from public.inventory
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'),
  (select coalesce(sum(m.qty), 0)::numeric
     from public.stock_movements m
    where m.product_id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'),
  'G5 stock_qty equals sum(stock_movements) after seeded sales');
select is(
  public.available_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001')::numeric,
  (select stock_qty::numeric from public.inventory
    where id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'),
  'G5b available_stock() reads the same number as the read model');

-- ---------- add_inventory_item: product + opening stock in ONE call --------
-- Assert on the RETURNED row's name (field selection) rather than
-- `f(...) IS NOT NULL`: is() prints have/want diagnostics on failure, so a
-- regression here says what actually came back instead of just "not ok".
select is(
  (public.add_inventory_item(
    '{"name": "RPC Item", "category": "Other", "sale_price": 10, "cost_price": 4}'::jsonb,
    3)).name,
  'RPC Item',
  'add_inventory_item() returns the created product');
select is(
  (select stock_qty from public.inventory where name = 'RPC Item'),
  3::integer, 'opening stock is live in stock_qty immediately');
select is(
  (select coalesce(sum(m.qty), 0)::numeric
     from public.stock_movements m
     join public.inventory i on i.id = m.product_id
    where i.name = 'RPC Item'),
  3::numeric, 'opening stock wrote a real ledger movement');

-- ---------- constraints are enforced, not merely declared ------------------
select ok(
  coalesce(
    (select bool_and(convalidated)
       from pg_constraint
      where conname in ('sale_items_qty_positive',
                        'sale_items_unit_price_nonneg',
                        'sale_items_total_matches',
                        'sales_amount_paid_nonneg',
                        'sales_discount_nonneg',
                        'sales_discount_le_total',
                        'sales_net_matches')),
    false),
  'money constraints exist and are VALIDATED (not left NOT VALID)');

-- ============================================================================
-- Every checkout outcome that was NOT what the assertion expected, printed as
-- one line per _cap row (picked up by CI's annotation pass). The keys excluded
-- below are the tests that EXPECT a rejection, so their errors are successes.
reset role;
select 'CAPERR ' || k || ' -> ' || coalesce(err, 'ok')
  from _cap
 where err is not null
   and k not in ('t7', 't8', 't9', 't10', 't11', 't13')
 order by k;

select * from finish();
rollback;
