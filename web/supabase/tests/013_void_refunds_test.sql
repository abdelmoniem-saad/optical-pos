-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 2 gate: 013_void_refunds_test.sql (pgTAP)
-- ============================================================
-- Proves PHASED_ROADMAP §5's gate against a database built from
-- 000…013 by scripts/test-db.sh:
--   G1 a mis-keyed sale can be VOIDED, and nothing is erased
--   G2 voiding returns stock and the customer's money to the
--      pre-sale values (ledger drives both, via the 011 trigger)
--   G3 direct DELETE is denied on all seven financial tables
--   G4 the money columns on `sales` are ledger-owned: a direct
--      write is refused
--   G5 re-checkout is a single server-priced transaction
--   G6 the ledger can express money going BACK (refunds)
-- plus: paid_at is a timestamptz, stock_movements has a real
-- vocabulary, and revoking DELETE did not over-restrict reads
-- and ordinary header edits.
--
-- Everything runs inside ONE transaction and ROLLS BACK: the
-- database is left exactly as it was. Runs as the `authenticated`
-- role with a JWT claim set, so RLS + the security-invoker RPCs
-- are exercised for real.
--
-- RED-HARNESS NOTE: this file is written so it still RUNS (and
-- reports `not ok`) against a database that has no 013 yet. Every
-- behavioural probe therefore goes through a plpgsql helper that
-- captures the exception instead of aborting the TAP stream, and
-- every structural probe reads the catalogs (has_column /
-- col_type_is / pg_policies), which cannot fail to parse.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(54);

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
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 'Test Lens A', 'Lens',  500.00, 200.00, test_store_id()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000002', 'Test Frame B', 'Frame', 100.00,  40.00, test_store_id());

-- Test Lens A starts with 5 on the shelf (fires the 012 stock_qty trigger).
insert into public.stock_movements (product_id, qty, type, note, store_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 5, 'initial', 'seed', test_store_id());

-- NOTE on the ::bigint casts below: pgTAP's is() has no (bigint, integer,
-- text) overload, so comparing count(*) to a bare integer literal does not
-- resolve and aborts the file with 'function is(bigint, integer, unknown) does
-- not exist'. The expected side is cast to bigint everywhere.
--
-- Scratch register: one row per probe, so a rejected call cannot abort the
-- whole TAP stream. Same trick the Phase 1 gate uses.
-- 014 turned voiding into a PERMISSION: require_perm(history.void) now runs
-- at the top of the function. This gate is about the void MECHANICS, not about
-- who may void, so the cashier is given the code explicitly - which keeps the
-- requirement visible: forget the grant and every void assertion below fails
-- with 'insufficient permission: history.void' rather than something subtler.
insert into public.user_permissions (user_id, permission_id, allow)
select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', p.id, true
  from public.permissions p where p.code = 'history.void'
on conflict (user_id, permission_id) do nothing;

create table _cap (k text primary key, sale_id uuid, note text, err text);
grant all on _cap to authenticated;

create function _checkout(
  p_k        text,
  p_sale     jsonb,
  p_items    jsonb,
  p_payments jsonb default '[]'::jsonb
) returns void
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.create_sale_order(p_sale, p_items, '[]'::jsonb, p_payments, null)).id;
  insert into _cap (k, sale_id) values (p_k, v_id);
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

-- void_sale() probe. 013 does not exist in the RED state, so the missing
-- function raises here and is captured rather than aborting the run.
create function _void(
  p_k        text,
  p_sale_id  uuid,
  p_reason   text,
  p_restock  boolean default true
) returns void
language plpgsql as $$
begin
  perform public.void_sale(p_sale_id, p_reason, p_restock);
  insert into _cap (k, sale_id, note) values (p_k, p_sale_id, 'ok');
exception when others then
  insert into _cap (k, sale_id, err) values (p_k, p_sale_id, sqlerrm);
end $$;

create function _recheckout(
  p_k        text,
  p_sale_id  uuid,
  p_sale     jsonb,
  p_items    jsonb,
  p_payments jsonb default '[]'::jsonb
) returns void
language plpgsql as $$
begin
  perform public.update_sale_order(p_sale_id, p_sale, p_items, '[]'::jsonb, p_payments);
  insert into _cap (k, sale_id, note) values (p_k, p_sale_id, 'ok');
exception when others then
  insert into _cap (k, sale_id, err) values (p_k, p_sale_id, sqlerrm);
end $$;

-- A direct write to a money column. Captured, so on a database without the
-- 013 guard trigger this records "allowed" and the assertion turns red
-- instead of the file dying.
create function _poke_money(p_k text, p_sale_id uuid, p_column text) returns void
language plpgsql as $$
begin
  execute format('update public.sales set %I = 1 where id = $1', p_column)
    using p_sale_id;
  insert into _cap (k, sale_id, note) values (p_k, p_sale_id, 'allowed');
exception when others then
  insert into _cap (k, sale_id, err) values (p_k, p_sale_id, sqlerrm);
end $$;

create function _stock(p_product uuid) returns integer
language sql stable as $$
  select stock_qty from public.inventory where id = p_product
$$;

create function _cap_err(p_k text) returns text
language sql stable as $$ select err from _cap where k = p_k $$;

-- ===== impersonate the signed-in cashier =====================================
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
  perform set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001"}', false);
end $$;

-- ---------- structure: the columns 013 adds --------------------------------
-- NOTE the 4-argument pgTAP form (schema, table, column, description): the
-- 3-argument form takes a BARE table name, so 'public.sales' would be looked
-- up as a table literally called public.sales, and every probe would fail for
-- a reason that has nothing to do with the schema.
select has_column('public', 'sales', 'voided_at',
  'S1 sales.voided_at records WHEN a sale was voided');
select has_column('public', 'sales', 'voided_by',
  'S2 sales.voided_by records WHO voided it');
select has_column('public', 'sales', 'void_reason',
  'S3 sales.void_reason records WHY');
select has_column('public', 'sale_payments', 'kind',
  'S4 sale_payments.kind separates a payment from a refund');
select has_column('public', 'sale_items', 'discount',
  'S5 sale_items.discount carries a line-level discount');
select has_column('public', 'sale_items', 'discount_reason',
  'S6 sale_items.discount_reason carries its reason');
select has_column('public', 'stock_movements', 'kind',
  'S7 stock_movements.kind replaces the free-text vocabulary');
select col_type_is('public', 'sale_payments', 'paid_at', 'timestamp with time zone',
  'S8 paid_at is a timestamptz, so two payments on one day differ');

-- ---------- a real sale to reverse -----------------------------------------
select _checkout('s1',
  '{"total_amount": 1000, "discount": 0, "net_amount": 1000, "amount_paid": 1000, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A"}]'::jsonb,
  '[{"method": "cash", "amount": 1000}]'::jsonb);
select is(_cap_err('s1'), null,
  'S9 seeded checkout succeeds');
select is(_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001'), 3,
  'S10 the sale drew 2 off the shelf (5 -> 3)');
select is((select amount_paid from public.sales where id = (select sale_id from _cap where k = 's1')),
  1000::numeric, 'S11 amount_paid is 1000 from the ledger');

-- ---------- G3: direct DELETE is denied (probe BEFORE any void) ------------
-- On 000…012 these four deletes actually erase rows, which is the defect.
delete from public.sale_items    where sale_id = (select sale_id from _cap where k = 's1');
delete from public.sale_payments where sale_id = (select sale_id from _cap where k = 's1');
delete from public.stock_movements where ref_no = (
  select invoice_no from public.sales where id = (select sale_id from _cap where k = 's1'));
delete from public.sales         where id = (select sale_id from _cap where k = 's1');

select is((select count(*) from public.sale_items
            where sale_id = (select sale_id from _cap where k = 's1')), 1::bigint,
  'G3a DELETE cannot remove a sale_items row');
select is((select count(*) from public.sale_payments
            where sale_id = (select sale_id from _cap where k = 's1')), 1::bigint,
  'G3b DELETE cannot remove a payment-ledger row');
select is((select count(*) from public.sales
            where id = (select sale_id from _cap where k = 's1')), 1::bigint,
  'G3c DELETE cannot remove the sale header');
select is((select count(*) from public.stock_movements where type = 'sale'), 1::bigint,
  'G3d DELETE cannot remove a stock movement');

-- ...and the policies that allowed it are gone from all seven money tables.
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'sales'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3e no delete policy on sales');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'sale_items'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3f no delete policy on sale_items');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'sale_payments'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3g no delete policy on sale_payments');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'stock_movements'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3h no delete policy on stock_movements');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'purchases'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3i no delete policy on purchases');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'purchase_items'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3j no delete policy on purchase_items');
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'purchase_payments'
              and policyname = 'lensy_tenant_delete'), 0::bigint,
  'G3k no delete policy on purchase_payments');

-- ---------- G4: the money columns are ledger-owned -------------------------
select _poke_money('m1', (select sale_id from _cap where k = 's1'), 'amount_paid');
select matches(_cap_err('m1'), '^money columns are ledger-owned',
  'G4a a direct write to sales.amount_paid is refused');
select _poke_money('m2', (select sale_id from _cap where k = 's1'), 'net_amount');
select matches(_cap_err('m2'), '^money columns are ledger-owned',
  'G4b a direct write to sales.net_amount is refused');
select _poke_money('m3', (select sale_id from _cap where k = 's1'), 'total_amount');
select matches(_cap_err('m3'), '^money columns are ledger-owned',
  'G4c a direct write to sales.total_amount is refused');
select _poke_money('m4', (select sale_id from _cap where k = 's1'), 'discount');
select matches(_cap_err('m4'), '^money columns are ledger-owned',
  'G4d a direct write to sales.discount is refused');

-- ---------- G1/G2: voiding reverses the sale without erasing it -----------
select _void('v1', (select sale_id from _cap where k = 's1'), 'wrong customer', true);
select is(_cap_err('v1'), null,
  'G1a void_sale succeeds');
select is((select count(*) from public.sales where id = (select sale_id from _cap where k = 's1')), 1::bigint,
  'G1b the sale header is still there (void is an event, not a delete)');
select is((select count(*) from public.sale_items
            where sale_id = (select sale_id from _cap where k = 's1')), 1::bigint,
  'G1c the line items are still there');
select ok((select voided_at is not null from public.sales
            where id = (select sale_id from _cap where k = 's1')),
  'G1d voided_at is stamped');
select is((select voided_by from public.sales
            where id = (select sale_id from _cap where k = 's1'))::text,
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  'G1e voided_by is the signed-in cashier');
select is((select void_reason from public.sales
            where id = (select sale_id from _cap where k = 's1')),
  'wrong customer', 'G1f the reason is recorded verbatim');

select is(_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001'), 5,
  'G2a voiding with restock puts the 2 units back on the shelf');
select is((select amount_paid from public.sales where id = (select sale_id from _cap where k = 's1')),
  0::numeric, 'G2b the customer''s money is fully returned (amount_paid back to 0)');

-- ---------- G6: the ledger can express money going back -------------------
select is((select count(*) from public.sale_payments
            where sale_id = (select sale_id from _cap where k = 's1')
              and kind = 'refund' and amount < 0), 1::bigint,
  'G6a the refund is a negative ledger row tagged kind=refund');
select is((select sum(amount) from public.sale_payments
            where sale_id = (select sale_id from _cap where k = 's1')), 0::numeric,
  'G6b payments and refunds cancel to exactly zero');
select is((select kind from public.stock_movements
            where product_id = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
              and qty > 0 and type <> 'initial' limit 1), 'void_restock',
  'G6c the restock movement is a first-class kind, not free text');

-- ---------- voiding twice, and voiding without restock ------------------
select _void('v2', (select sale_id from _cap where k = 's1'), 'again', true);
select matches(_cap_err('v2'), 'already voided',
  'G1g voiding an already-voided sale is refused');

select _checkout('s2',
  '{"total_amount": 500, "discount": 0, "net_amount": 500, "amount_paid": 500, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb,
  '[{"method": "cash", "amount": 500}]'::jsonb);
select is(_cap_err('s2'), null, 'G1h a second seeded checkout succeeds');
select _void('v3', (select sale_id from _cap where k = 's2'), 'returned to customer', false);
select is(_cap_err('v3'), null, 'G1i voiding without restock succeeds');
select is(_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001'), 4,
  'G2c without restock the unit stays off the shelf (5 - 1)');

-- ---------- G5: re-checkout is server-priced and atomic ------------------
-- s2 was deliberately voided above (G1i) and a voided sale must refuse edits,
-- so re-checkout gets its own live invoice. Stock ledger up to here:
--   5 seeded -> s1 takes 2 (3) -> s1 void WITH restock (5)
--          -> s2 takes 1 (4) -> s2 void WITHOUT restock (4, unchanged)
select _checkout('s3',
  '{"total_amount": 500, "discount": 0, "net_amount": 500, "amount_paid": 500, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 500, "total_price": 500, "name": "Test Lens A"}]'::jsonb,
  '[{"method": "cash", "amount": 500}]'::jsonb);
select is(_cap_err('s3'), null, 'G5g the sale we re-checkout is created');
select is(_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001'), 3,
  'G5h it drew 1 off the shelf (4 - 1)');

-- A voided sale refuses edits - that is the point of voiding, not a bug.
select _recheckout('r0', (select sale_id from _cap where k = 's2'),
  '{"net_amount": 500, "amount_paid": 500}'::jsonb,
  '[]'::jsonb);
select matches(_cap_err('r0'), 'voided',
  'G5i a voided sale can no longer be edited');

select _recheckout('r1', (select sale_id from _cap where k = 's3'),
  '{"net_amount": 900, "amount_paid": 900, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 1, "unit_price": 1, "total_price": 1, "name": "Test Lens A"}]'::jsonb,
  '[{"method": "cash", "amount": 900}]'::jsonb);
select matches(_cap_err('r1'), 'price changed',
  'G5a re-checkout with a tampered line price is refused');
select is((select unit_price from public.sale_items
            where sale_id = (select sale_id from _cap where k = 's3')), 500::numeric,
  'G5b the stored line price is untouched by the refused re-checkout');

select _recheckout('r2', (select sale_id from _cap where k = 's3'),
  '{"net_amount": 1000, "amount_paid": 1000, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A"}]'::jsonb,
  '[{"method": "cash", "amount": 1000}]'::jsonb);
select is(_cap_err('r2'), null, 'G5c an honest re-checkout succeeds');
select is((select count(*) from public.sale_items
            where sale_id = (select sale_id from _cap where k = 's3')), 1::bigint,
  'G5d the lines are replaced, not appended to');
select is((select sum(amount) from public.sale_payments
            where sale_id = (select sale_id from _cap where k = 's3')), 1000::numeric,
  'G5e the payment ledger is replaced too');
select is(_stock('bbbbbbbb-bbbb-4bbb-8bbb-000000000001'), 2,
  'G5f stock follows the replaced lines: 1 became 2, so 3 - 1 = 2');

-- ---------- line-level discount -----------------------------------------
select _checkout('d1',
  '{"net_amount": 900, "amount_paid": 900, "payment_method": "Cash"}'::jsonb,
  '[{"product_id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "qty": 2, "unit_price": 500, "total_price": 1000, "name": "Test Lens A", "discount": 100, "discount_reason": "loyal customer"}]'::jsonb,
  '[{"method": "cash", "amount": 900}]'::jsonb);
select is(_cap_err('d1'), null, 'G7a a line-level discount is accepted');
select is((select discount from public.sale_items
            where sale_id = (select sale_id from _cap where k = 'd1')), 100::numeric,
  'G7b the line discount is stored on the item');

-- ---------- revoking DELETE must not over-restrict ------------------------
select is((select count(*) from public.sales where invoice_no is not null), 4::bigint,
  'G8a the cashier can still READ their sales (s1, s2, s3, d1)');
select _poke_money('m5', (select sale_id from _cap where k = 's2'), 'doctor_name');
select is(_cap_err('m5'), null,
  'G8b an ordinary (non-money) header edit still works');

rollback;
