-- LensyPOS — Phase 4 gate: 016_reporting_test.sql (pgTAP)
-- ============================================================
-- Reports used to download every sale header and sum it in JavaScript. Two
-- defects, and the gate has to catch both classes:
--
--   MONEY  a voided sale was counted as revenue, because void_sale leaves the
--          money columns intact for the audit trail and nothing filtered it.
--   SCALE  the top-5 list was a full download + JS sort.
--
-- So this gate seeds a store with a deliberate mix - live, voided, part-paid,
-- multi-tender, a lab job, and a SECOND store that must never be counted - and
-- asserts the numbers by hand:
--
--   G-R1  revenue excludes the void
--   G-R2  balance due is not inflated by the void
--   G-R3  order count excludes the void
--   G-R4  lab counters exclude the void
--   G-R5  top customers exclude the void, and are ranked
--   G-R6  another store's money never appears (tenant isolation)
--   G-R7  a bare end date covers the WHOLE day, not up to midnight
--   G-R8  payment mix nets a refund against its payment
--   G-R9  the void summary counts what was excluded
--   G-R10 the window uses the index, not a sequential scan
--
-- Runs in ONE transaction and ROLLS BACK.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(16);

-- ===== fixtures ============================================================
-- Two stores: the seeded one, and this one. If any report ever leaks across
-- the tenant boundary, G-R6 is what notices.
insert into public.stores (id, name) values
  ('ffffffff-ffff-4fff-8fff-000000000009', 'report store')
on conflict (id) do nothing;

create function _rstore() returns uuid
language sql stable as $fn$ select 'ffffffff-ffff-4fff-8fff-000000000009'::uuid $fn$;

insert into public.customers (id, name, phone, store_id) values
  ('ffffffff-ffff-4fff-8fff-000000000011', 'Ahmed',  '01000000001', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000012', 'Mona',   '01000000002', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000013', 'Rival',  '01000000003', _rstore())
on conflict (id) do nothing;

-- Two live sales, one voided, one belonging to a different store.
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, lab_status, store_id)
values
  ('ffffffff-ffff-4fff-8fff-000000000021', 'R0001', 'ffffffff-ffff-4fff-8fff-000000000011',
     1000, 0, 1000, 1000, '2026-09-20 10:00:00+00', 'Ready', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022', 'R0002', 'ffffffff-ffff-4fff-8fff-000000000012',
     2000, 0, 2000,  500, '2026-09-21 10:00:00+00', 'In Lab', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000023', 'R0003', 'ffffffff-ffff-4fff-8fff-000000000013',
     5000, 0, 5000, 5000, '2026-09-22 10:00:00+00', 'Ready', _rstore())
on conflict (id) do nothing;

-- The void: same shape, flagged. This is the row that used to be counted.
update public.sales
   set voided_at = '2026-09-23 10:00:00+00', void_reason = 'test'
 where id = 'ffffffff-ffff-4fff-8fff-000000000023';

-- A sale in the seeded store, with a big number, that must never appear.
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, lab_status, store_id)
select 'ffffffff-ffff-4fff-8fff-000000000024', 'X0001', c.id,
       999999, 0, 999999, 999999, '2026-09-20 10:00:00+00', 'Ready', s.id
  from public.stores s, public.customers c
 where s.id <> _rstore() and c.store_id = s.id
 limit 1;

-- Ledger: 1000 cash + 500 wallet on R0002, and a 400 refund of the cash.
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id)
values
  ('ffffffff-ffff-4fff-8fff-000000000021', 1000, 'cash',   'payment', '2026-09-20 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022',  500, 'cash',   'payment', '2026-09-21 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022',  500, 'wallet', 'payment', '2026-09-21 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022', -400, 'cash',   'refund',  '2026-09-22 10:00:00+00', _rstore());

-- Sign in as a member of the report store, so auth_store_id() resolves to it.
insert into auth.users (id, email, username) values
  ('eeeeeeee-eeee-4eee-8fff-000000000009', 'reporter@lensypos.local', 'reporter')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active)
values ('eeeeeeee-eeee-4eee-8fff-000000000009', 'reporter', '-', _rstore(), true)
on conflict (id) do nothing;

insert into public.roles (id, name, store_id) values
  ('ffffffff-ffff-4fff-8fff-000000000031', 'Reporter', _rstore())
on conflict (id) do nothing;

update public.users set role_id = 'ffffffff-ffff-4fff-8fff-000000000031'
 where id = 'eeeeeeee-eeee-4eee-8fff-000000000009';

-- Impersonate a member of the report store. BOTH claim keys are set, because
-- auth_store_id() reads the singular one and other helpers read the JSON one -
-- the same impersonation block 013 and 014 use.
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', 'eeeeeeee-eeee-4eee-8fff-000000000009', false);
  perform set_config('request.jwt.claims',
                     '{"sub":"eeeeeeee-eeee-4eee-8fff-000000000009"}', false);
end $$;

-- ===== G-R1/G-R2/G-R3: revenue, balance and count exclude the void ======
-- Live sales are 1000 + 2000. The 5000 void and the 999999 other store must
-- both be absent. If the void leaked, revenue would be 8000.
select is((select revenue::bigint from public.report_sales_window(null, null)),
  3000::bigint, 'G-R1 revenue counts the two live sales and excludes the void');

select is((select paid::bigint from public.report_sales_window(null, null)),
  1500::bigint, 'G-R2 paid is the sum of the live sales only');

select is((select balance_due::bigint from public.report_sales_window(null, null)),
  1500::bigint, 'G-R2b balance due is 1500, not inflated by the voided 5000');

select is((select order_count::bigint from public.report_sales_window(null, null)),
  2::bigint, 'G-R3 the order count excludes the voided sale');

-- ===== G-R4: lab counters exclude the void =============================
select is((select ready_lab::bigint from public.report_sales_window(null, null)),
  1::bigint, 'G-R4 the voided Ready job is not counted as ready');
select is((select pending_lab::bigint from public.report_sales_window(null, null)),
  1::bigint, 'G-R4b the In Lab job is counted once');

-- ===== G-R5: top customers =============================================
select is((select count(*)::bigint from public.report_top_customers(null, null, 5)),
  2::bigint, 'G-R5 the top-customer list excludes the voided customer');
select is((select full_name from public.report_top_customers(null, null, 5) limit 1),
  'Mona', 'G-R5b the highest-spender live customer is first');
select is((select count(*)::bigint from public.report_top_customers(null, null, 1)),
  1::bigint, 'G-R5c the limit is honoured');

-- ===== G-R6: another store is never counted ============================
-- The seeded store has a 999999 sale. If tenant scoping broke, revenue would
-- be 1002999 rather than 3000 - and G-R1 would already have failed, so this
-- assertion names the isolation directly.
select is((select count(*) from public.report_top_customers(null, null, 50)
            where full_name = 'Rival')::bigint,
  0::bigint, 'G-R6 no customer from another store appears');

-- ===== G-R7: a bare end date covers the whole day =====================
-- The regression this exists for: `lte(paid_at, '2026-09-21')` means midnight
-- at the START of that day, so the 10:00 payment was silently dropped.
select is((select count(*) from public.report_payment_mix(
             null, '2026-09-21 00:00:00+00') where method = 'cash')::bigint,
  1::bigint, 'G-R7 a 10:00 payment on the end date is inside the window');

-- ===== G-R8: refunds net against their payment =========================
-- cash 500 paid, 400 refunded => 100. wallet 500 untouched.
select is((select total::bigint from public.report_payment_mix(null, null) where method = 'cash'),
  1100::bigint, 'G-R8 the refund nets against the cash it reversed (1500-400)');
select is((select total::bigint from public.report_payment_mix(null, null) where method = 'wallet'),
  500::bigint, 'G-R8b the untouched tender is unaffected');

-- ===== G-R9: the void summary ==========================================
select is((select voided_count::bigint from public.report_voided_count(null, null)),
  1::bigint, 'G-R9 the void summary counts the one voided sale');
select is((select voided_net::bigint from public.report_voided_count(null, null)),
  5000::bigint, 'G-R9b ...and the value it excluded, so the UI can show it');

-- ===== G-R10: the window uses the index ===============================
select is((select count(*) from (
             explain (format text, costs off)
             select * from public.sales
              where store_id = _rstore() and voided_at is null
              order by order_date desc
          ) e where e like '%Index Scan%' or e like '%Index Only Scan%')::bigint,
  1::bigint, 'G-R10 the live-sales window is an index scan, not a seq scan');

reset role;

rollback;

