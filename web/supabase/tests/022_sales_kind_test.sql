-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 6 gate: 022_sales_kind_test.sql (pgTAP)
-- ============================================================
-- useAddStandalonePrescription writes a `sales` row with no items and no money,
-- and nothing said so. The revenue numbers were never wrong - 016 sums
-- net_amount, so a zero row adds 0 - so this gate is NOT about money. It is about
-- `order_count` being `count(*)`, which meant "Orders today: 12" counted
-- prescriptions nobody paid for.
--
--   G-K1  the column exists, so a prescription can declare what it is
--   G-K2  the default is 'sale', so legacy rows and the OLD client are sales
--   G-K2b the check constraint is VALIDATED, not left `not valid`
--   G-K3  the RPC is still callable under its 5-argument signature
--   G-K4  a real checkout is stored as kind = 'sale'
--   G-K5  a prescription is stored as kind = 'prescription', and still has its exam
--   G-K6  a TAMPERED kind ('garbage') is stored as 'sale', not as sent
--   G-K6b ...and the checkout still succeeds, rather than erroring on a bad value
--   G-K7  the reverse tamper: claiming 'prescription' on an order that HAS
--         items still stores 'sale', so a client cannot hide a real sale
--   G-K8  a prescription is EXCLUDED from order_count
--   G-K9  ...but is STILL counted as pending lab - the assertion that proves the
--         fix did not over-correct into understating the lab queue
--   G-K10 revenue AND paid are unchanged: the fix moved one number, not the report
--   G-K11 a direct UPDATE cannot set a kind outside the whitelist
--   G-K12 another store's prescription appears in neither count nor lab queue
--   G-K13 022 stamped itself, so the drift banner can fire
--
-- G-K9 and G-K10 are the two that matter most. The obvious "fix" for an inflated
-- count is to exclude the row everywhere it appears, which is how a report ends
-- up quietly understating the lab queue. Those two assertions are what make the
-- narrow fix checkable rather than merely plausible.
--
-- lab_status is sent EXPLICITLY on every checkout rather than left to the column
-- default. useCreateSale sends 'Not Started' only when the order carries exams,
-- so leaving it out would make the lab counters depend on a default that the
-- client controls - and an assertion that passes or fails on a default is not an
-- assertion about this migration.
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
-- 18. Re-derived from the assertions before every commit rather than trusted
-- from memory: a plan that is short makes pgTAP fail the whole file on
-- completion even when every assertion passed, and this file has now been wrong
-- about its own count twice (13, then 17).
select plan(18);

-- ===== fixtures ==============================================================
-- A second store, for the isolation assertion.
--
-- It is deliberately NOT licensed, and an earlier draft of this file claimed it
-- had to be - on the theory that an unlicensed store would make the assertion
-- pass for the wrong reason, as run #76 did over license_write_ok. That is wrong
-- here: report_sales_window scopes by auth_store_id() alone and never consults
-- the licence, so a licence on this row would change nothing. The isolation is
-- proved by the store_id match and nothing else.
insert into public.stores (id, name) values
  ('cccccccc-cccc-4ccc-8ccc-000000000022', 'other store')
  on conflict (id) do nothing;

create function k_store() returns uuid
  language sql stable as $$ select id from public.stores order by created_at limit 1 $$;

-- A cashier for the seeded store, and one lens to sell.
insert into auth.users (id, email, username) values
  ('cccccccc-cccc-4ccc-8ccc-0000000000a1', 'kashier@lensypos.local', 'kashier')
  on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active)
values ('cccccccc-cccc-4ccc-8ccc-0000000000a1', 'kashier', '-', k_store(), true)
  on conflict (id) do nothing;

insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values ('dddddddd-dddd-4ddd-8ddd-000000000001', 'Kind Lens', 'Lens', 400.00, 100.00, k_store())
  on conflict (id) do nothing;

insert into public.stock_movements (product_id, qty, type, note, store_id)
values ('dddddddd-dddd-4ddd-8ddd-000000000001', 10, 'initial', 'seed', k_store());

-- Scratch register, as in the 012 gate: a rejected call must not abort the stream.
create table _cap (k text primary key, sale_id uuid, kind text, err text);
grant all on _cap to authenticated;

create function _checkout(
  p_k        text,
  p_sale     jsonb,
  p_items    jsonb,
  p_exams    jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb
) returns void
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.create_sale_order(p_sale, p_items, p_exams, p_payments, null)).id;
  insert into _cap (k, sale_id, kind)
  select p_k, v_id, s.kind from public.sales s where s.id = v_id;
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

create function _kcount() returns bigint
  language sql stable as $$
  select order_count from public.report_sales_window(null, null) $$;

create function _impersonate() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-0000000000a1', false);
  perform set_config('request.jwt.claims',
                     '{"sub":"cccccccc-cccc-4ccc-8ccc-0000000000a1"}', false);
end $$;

-- ===== G-K1 / G-K2 / G-K2b / G-K3: the shape ================================
-- Structural first, while still running as the migration's own role.
select has_column('public', 'sales', 'kind',
  'G-K1 sales.kind exists, so a prescription can declare what it is');

-- Default, not a backfilled-and-then-constrained nullable column: a legacy row
-- and any row the OLD client writes are both a sale, which is the right reading
-- of "nobody claimed otherwise".
--
-- quote_literal() rather than a hand-doubled quote string, and an explicit ::text
-- cast. Two separate pgTAP traps on one line, both of which this repository has
-- already paid for:
--   * the first version wrote five quote characters where six were needed, which
--     is a syntax error rather than a failed assertion;
--   * column_default is information_schema.sql_identifier, and pgTAP's is() has
--     no overload for a domain - it reports "function is(character_data, text,
--     unknown) does not exist", which reads like a missing extension and is
--     really a missing cast. The rule from Phase 5: cast every catalog value.
select is((select column_default::text from information_schema.columns
            where table_schema = 'public' and table_name = 'sales' and column_name = 'kind'),
         quote_literal('sale'),
  'G-K2 the default is sale, so absent means sale and no legacy row needs backfilling');

-- `not valid` would have let the migration through with a constraint that nothing
-- enforces, so this asserts the VALIDATION happened rather than trusting the
-- add-constraint statement above it. Same trap as 012's seven money constraints,
-- which were each added `not valid` and then validated.
select is((select count(*)::int from pg_constraint
            where conname = 'sales_kind_check' and not convalidated), 0,
  'G-K2b the kind constraint is validated, not left NOT VALID');

-- 022 adds no argument, so the client's rpc() call is unchanged. That is the
-- whole reason this is `create or replace` on the existing signature rather than
-- a drop-and-recreate, which would have needed a client change and a window in
-- which checkout did not work at all.
select has_function('public', 'create_sale_order',
  'G-K3 create_sale_order still exists under its 5-argument signature');

-- ===== impersonate the signed-in cashier =====================================
-- BOTH claim keys, because auth_store_id() reads the singular one and other
-- helpers read the JSON one - the same block 012, 013, 014 and 016 use.
set role authenticated;
select _impersonate();

-- ===== G-K4: a real checkout is a sale =======================================
-- No `kind` in the payload at all, which is what the current client sends.
select _checkout('k1',
  '{"total_amount": 400, "discount": 0, "net_amount": 400, "amount_paid": 400, "payment_method": "Cash", "lab_status": "Not Started"}'::jsonb,
  '[{"product_id": "dddddddd-dddd-4ddd-8ddd-000000000001", "qty": 1, "unit_price": 400, "total_price": 400, "name": "Kind Lens"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 400}]'::jsonb);
select is((select kind from _cap where k = 'k1'), 'sale',
  'G-K4 an ordinary checkout is stored as kind = sale (absent means sale)');

-- ===== G-K5: a prescription is a prescription ================================
-- Exactly what useAddStandalonePrescription sends: no items, no money, one exam.
select _checkout('k2',
  '{"total_amount": 0, "discount": 0, "net_amount": 0, "amount_paid": 0, "kind": "prescription", "lab_status": "Not Started"}'::jsonb,
  '[]'::jsonb,
  '[{"exam_type": "SINGLE", "sphere_od": -1.00, "cylinder_od": -0.50, "axis_od": 180}]'::jsonb,
  '[]'::jsonb);
select is((select kind from _cap where k = 'k2'), 'prescription',
  'G-K5 a standalone prescription is stored as kind = prescription');
select is((select count(*)::int from public.order_examinations
            where sale_id = (select sale_id from _cap where k = 'k2')), 1,
  'G-K5b the prescription still carries its exam - it is a real record, not a stub');

-- ===== G-K6: a tampered kind is not believed ==================================
-- create_sale_order exists because it does not trust the browser: it re-prices
-- the cart and re-totals the header. `kind` is client-supplied too, so it is
-- whitelisted in the function rather than passed through by
-- jsonb_populate_record - which would have copied 'totally-not-a-kind' straight
-- into a column the check constraint then rejects, turning a claim into a 500.
select _checkout('k3',
  '{"total_amount": 0, "discount": 0, "net_amount": 0, "amount_paid": 0, "kind": "totally-not-a-kind", "lab_status": "Not Started"}'::jsonb,
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select is((select kind from _cap where k = 'k3'), 'sale',
  'G-K6 an invented kind is stored as sale, not as sent');
select is((select err from _cap where k = 'k3'), null,
  'G-K6b and the checkout still SUCCEEDS - an unknown kind is not an error');

-- ===== G-K7: the reverse tamper is closed too ================================
-- The subtler one, and the reason the whitelist is not enough on its own. With
-- only a whitelist, a client could relabel a REAL order as a prescription and
-- drop it out of order_count - hiding a sale from the count. Requiring a cart
-- worth nothing is what stops it: t.total_amount is the gross the catalog says
-- the cart is worth, so a real order stays a sale even at 100% discount.
select _checkout('k4',
  '{"total_amount": 400, "discount": 0, "net_amount": 400, "amount_paid": 400, "kind": "prescription", "lab_status": "Not Started"}'::jsonb,
  '[{"product_id": "dddddddd-dddd-4ddd-8ddd-000000000001", "qty": 1, "unit_price": 400, "total_price": 400, "name": "Kind Lens"}]'::jsonb,
  '[]'::jsonb,
  '[{"method": "cash", "amount": 400}]'::jsonb);
select is((select kind from _cap where k = 'k4'), 'sale',
  'G-K7 claiming prescription on an order that HAS items still stores sale');


-- ===== G-K8 / G-K9: the count, and what must NOT change =======================
-- Wide-open window, and k1..k4 are the only rows in this store, so every number
-- is attributable one-for-one. Three are sales (k1, k3, k4) and one is the
-- prescription (k2).
select is(_kcount(), 3::bigint,
  'G-K8 the prescription is excluded from order_count (k1, k3, k4 are the sales)');

-- G-K9 is the assertion that matters most. The obvious over-correction is to
-- exclude the prescription from everything it appears in, which would understate
-- the lab queue - a prescription genuinely IS a job waiting. All four checkouts
-- carry lab_status 'Not Started', so all four are pending.
select is((select pending_lab from public.report_sales_window(null, null)), 4::bigint,
  'G-K9 the prescription is STILL counted as a pending lab job - not over-corrected');

-- ===== G-K10: money is untouched ==============================================
-- The whole premise is that revenue was NEVER wrong - 016 sums net_amount, so a
-- zero-total row contributes nothing. If this ever moves, the fix has changed the
-- report rather than the count, which is the failure 016's own history records
-- (voided rows inflating revenue, and the fix nearly going in the wrong column).
select is((select revenue::bigint from public.report_sales_window(null, null)), 800::bigint,
  'G-K10 revenue is unchanged: 400 (k1) + 400 (k4) + 0 (prescription) + 0 (k3)');
select is((select paid::bigint from public.report_sales_window(null, null)), 800::bigint,
  'G-K10b paid is unchanged at the two real checkouts only');

-- ===== G-K11: the whitelist is enforced by the schema, not just the function ===
-- A security property that lives only in application code is one refactor away
-- from being gone. The constraint is what makes it structural.
select throws_ok(
  $$update public.sales set kind = 'hacked'
     where id = (select sale_id from _cap where k = 'k1')$$,
  '23514', null,
  'G-K11 a direct UPDATE cannot invent a third kind - the constraint holds even without the RPC');

-- ===== G-K12: tenant isolation ===============================================
-- A prescription in ANOTHER store must not move this store's numbers. Inserted as
-- the migration's own role, because RLS would otherwise refuse a sale belonging
-- to a store the impersonated cashier does not belong to - and then the assertion
-- would pass for the wrong reason, having proved only that RLS works.
reset role;
insert into public.sales (invoice_no, store_id, total_amount, discount, net_amount,
                          amount_paid, order_date, lab_status, kind)
values ('K0001', 'cccccccc-cccc-4ccc-8ccc-000000000022', 0, 0, 0, 0,
        now(), 'Not Started', 'prescription');
set role authenticated;
select _impersonate();

select is(_kcount(), 3::bigint,
  'G-K12 the other store''s prescription does not appear in this store''s order count');
select is((select pending_lab from public.report_sales_window(null, null)), 4::bigint,
  'G-K12b ...nor in its lab queue');

-- ===== G-K13: 022 stamped itself =============================================
-- check-migrations-stamp.sh checks the FILE; this checks the LEDGER, which is
-- the half the file check cannot see. Both exist because 018 and 019 shipped
-- without either. Read as the migration's own role: lensy_schema_versions has RLS
-- on and no direct read for a client, so asking as `authenticated` would report
-- an empty ledger and pass for the wrong reason.
reset role;
select is((select max(version) from public.lensy_schema_versions), 22::int,
  'G-K13 022 recorded its own version, so the drift banner can fire');

select * from finish();
rollback;
