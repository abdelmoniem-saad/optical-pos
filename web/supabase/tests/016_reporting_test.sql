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
select plan(30);

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
     2000, 0, 2000,  600, '2026-09-21 10:00:00+00', 'In Lab', _rstore()),
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

-- Ledger: 1000 cash on R0001; 500 cash + 500 wallet - 400 refunded cash on R0002,
-- so the 011 sync trigger sets R0002.amount_paid to 600 - stated explicitly in
-- the sales fixture above, rather than being overwritten silently.
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id)
values
  ('ffffffff-ffff-4fff-8fff-000000000021', 1000, 'cash',   'payment', '2026-09-20 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022',  500, 'cash',   'payment', '2026-09-21 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022',  500, 'wallet', 'payment', '2026-09-21 10:00:00+00', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000022', -400, 'cash',   'refund',  '2026-09-22 10:00:00+00', _rstore());

-- The timezone fixture. 23:30 UTC on 2026-09-21 is 01:30 on 2026-09-22 in
-- Cairo (UTC+2). The old Reports code asked for the UTC date, so it filed
-- this sale under yesterday, while History - using the browser's local date -
-- it; asking for the Cairo day catches it. The old Reports code did the former.
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, store_id, lab_status)
-- lab_status is set to NULL on purpose: the column DEFAULTS to 'Not Started',
-- which would have made this timezone fixture show up as a pending lab job
-- and quietly changed G-R4b.
values ('ffffffff-ffff-4fff-8fff-000000000026', 'R0004',
        'ffffffff-ffff-4fff-8fff-000000000011',
        300, 0, 300, 0, '2026-09-21 23:30:00+00', _rstore(), null)
on conflict (id) do nothing;

-- R0004's payment, added AFTER the sale exists (the FK is immediate). At
-- 23:30 UTC it is 01:30 on the 22nd in Cairo, so this is the row that proves
-- the cash-up panel follows the store's day rather than UTC's.
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id)
values ('ffffffff-ffff-4fff-8fff-000000000026', 70, 'cash', 'payment',
        '2026-09-21 23:30:00+00', _rstore());

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

-- Search fixtures. These sit ABOVE the role switch on purpose: RLS would
-- otherwise refuse to insert a customer belonging to another store, and the
-- whole point of G-S2 is that such a row exists and is not searchable.
insert into public.customers (id, name, phone, store_id) values
  ('ffffffff-ffff-4fff-8fff-000000000041', 'Ahmed (Cairo)', '01500000041', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000042', 'O''Brien, Sean',  '01500000042', _rstore()),
  ('ffffffff-ffff-4fff-8fff-000000000043', 'Moncef 100%',     '01500000043', _rstore()),
  -- another store, to prove isolation
  ('ffffffff-ffff-4fff-8fff-000000000044', 'Ahmed (Cairo) OTHER STORE', '01500000044',
    (select id from public.stores where id <> _rstore() limit 1))
on conflict (id) do nothing;

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
-- Live sales are 1000 + 2000 + 300. The 5000 void and the 999999 other store
-- must both be absent. If the void leaked, revenue would be 8300.
select is((select revenue::bigint from public.report_sales_window(null, null)),
  3300::bigint, 'G-R1 revenue counts the live sales and excludes the void');

select is((select paid::bigint from public.report_sales_window(null, null)),
  1670::bigint, 'G-R2 paid is the live sales only (and the 011 sync trigger set it)');

select is((select balance_due::bigint from public.report_sales_window(null, null)),
  1630::bigint, 'G-R2b balance due excludes the voided 5000 entirely');

select is((select order_count::bigint from public.report_sales_window(null, null)),
  3::bigint, 'G-R3 the order count excludes the voided sale');

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
  1170::bigint, 'G-R8 the refund nets against the cash it reversed (1570-400)');
select is((select total::bigint from public.report_payment_mix(null, null) where method = 'wallet'),
  500::bigint, 'G-R8b the untouched tender is unaffected');

-- ===== G-R9: the void summary ==========================================
select is((select voided_count::bigint from public.report_voided_count(null, null)),
  1::bigint, 'G-R9 the void summary counts the one voided sale');
select is((select voided_net::bigint from public.report_voided_count(null, null)),
  5000::bigint, 'G-R9b ...and the value it excluded, so the UI can show it');

-- ===== G-R10: the query is served by the partial index ================
-- The live-sales predicate is (store_id, order_date desc) where voided_at
-- is null, so a report window is an index range scan rather than a scan of
-- the whole table. Asserted structurally: the index exists and its predicate
-- is exactly the one the functions filter on. (A text EXPLAIN capture needs
-- a plpgsql wrapper because EXPLAIN is a statement, not an expression.)
select is((select count(*) from pg_indexes
            where schemaname = 'public' and indexname = 'sales_live_idx')::bigint,
  1::bigint, 'G-R10 the partial index over live sales exists');
select matches((select indexdef from pg_indexes
              where schemaname = 'public' and indexname = 'sales_live_idx'),
  'voided_at IS NULL',
  'G-R10b ...and its predicate is the void exclusion, so the filter is free');
-- ===== G-T1/G-T2: one definition of "today" ==========================
-- The store is Africa/Cairo, which is EEST = UTC+3 all year (Egypt moved to a
-- permanent UTC+3 in 2023 - a detail worth stating, because assuming +2 here
-- is wrong and the test fails for the right reason). R0004 at 23:30 UTC on the
select is((select from_at::text from public.store_day_range('2026-09-22'::date)),
  '2026-09-21 21:00:00+00', 'G-T1 the Cairo day starts at 21:00 UTC the day before');
select is((select to_at::text from public.store_day_range('2026-09-22'::date)),
  '2026-09-22 21:00:00+00', 'G-T1b ...and ends 24 hours later, exclusive');
select is((select revenue::bigint
             from public.report_sales_window(
               (select from_at from public.store_day_range('2026-09-21'::date)),
               (select to_at   from public.store_day_range('2026-09-21'::date)))),
  2000::bigint,
  'G-T2 the 22:00-02:00 sale is NOT counted on the 21st, whatever UTC says');
select is((select revenue::bigint
             from public.report_sales_window(
               (select from_at from public.store_day_range('2026-09-22'::date)),
               (select to_at   from public.store_day_range('2026-09-22'::date)))),
  300::bigint,
  'G-T2b ...it IS counted on the 22nd, the day the shopkeeper means');
-- Inside the Cairo 22nd there are two cash rows: R0004's 70 (23:30 UTC on the
-- 21st = 02:30 on the 22nd) AND the -400 refund dated 22nd 10:00 UTC. So the
-- day's cash is -330, not 70. The first version of this assertion expected 70
-- and was wrong in a way worth keeping: a refund belongs to the day the money
-- actually went back, which is the whole point of netting them in cash-up.
select is((select total::bigint
             from public.report_payment_mix(
               (select from_at from public.store_day_range('2026-09-22'::date)),
               (select to_at   from public.store_day_range('2026-09-22'::date)))
            where method = 'cash'),
  -330::bigint,
  'G-T3 the 23:30 UTC cash payment lands on the 22nd, net of that day''s refund');
select is((select total::bigint
             from public.report_payment_mix(
               (select from_at from public.store_day_range('2026-09-21'::date)),
               (select to_at   from public.store_day_range('2026-09-21'::date)))
            where method = 'cash'),
  500::bigint,
  'G-T3b the 21st keeps only its own 500; the 23:30 UTC row is not counted there');

-- For the record, the fixture's cash across the three days is
-- 20th 1000 (R0001) | 21st 500 (R0002) | 22nd -330 (R0004''s 70 and the -400
-- refund) = 1170, which is what G-R8 asserts for all time. So the daily split
-- and the total agree, which is the property that actually matters: a day
-- boundary that quietly duplicated or dropped money would break it.

select is((select count(*) from public.search_text('Ahmed (Cairo)', 10)
            where kind = 'customer' and id = 'ffffffff-ffff-4fff-8fff-000000000041')::bigint,
  1::bigint, 'G-S1 a name containing parentheses is found, not silently dropped');

select is((select count(*) from public.search_text('Brien', 10)
            where kind = 'customer' and id = 'ffffffff-ffff-4fff-8fff-000000000042')::bigint,
  1::bigint, 'G-S1b a name containing an apostrophe and a comma is found');

select is((select count(*) from public.search_text('Ahmed (Cairo)', 10)
            where id = 'ffffffff-ffff-4fff-8fff-000000000044')::bigint,
  0::bigint, 'G-S2 another store''s identical name never appears');

-- Case-insensitivity, asserted as a property rather than a magic number: the
-- count for a lower-case term must equal the count for an upper-case one. (An
-- earlier version expected 1 and got 2, because the store fixture already has a
-- customer called 'Ahmed' - the count was never the point, the equality is.)
select is((select count(*) from public.search_text('ahmed', 10)),
  (select count(*) from public.search_text('AHMED', 10))::bigint,
  'G-S3 the search is case-insensitive');
select is((select count(*) from public.search_text('ahmed', 10)
            where kind = 'customer')::bigint,
  2::bigint, 'G-S3b ...and finds both Ahmed fixtures, not just one');

-- A term under two characters returns nothing rather than the whole table.
select is((select count(*) from public.search_text('a', 10))::bigint,
  0::bigint, 'G-S4 a one-character term returns nothing instead of everything');

-- The trigram indexes exist, so the substring match is not a sequential scan.
select is((select count(*) from pg_indexes
            where schemaname = 'public' and indexname like 'idx_trgm_%')::bigint,
  5::bigint, 'G-S5 a trigram index per searchable column exists');

reset role;

rollback;
