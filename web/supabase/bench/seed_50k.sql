-- web/supabase/bench/seed_50k.sql
--
-- Bulk-seed ONE store with 50,000 sales spread over ~2 years, plus a payment
-- ledger, so the report functions can be measured at a realistic "a few years
-- of a busy shop" scale.
--
-- This is a BENCHMARK fixture, NOT a migration and NOT a pgTAP gate. It lives
-- under bench/ so neither the migration glob (web/supabase/NNN_*.sql) nor the
-- gate glob (web/supabase/tests/*_test.sql) picks it up, and it creates no
-- schema objects, so the schema fingerprint is untouched.
--
-- Run against a freshly-migrated local database (see bench-queries.sh). The
-- load runs as the `postgres` superuser, so RLS is bypassed for the INSERTs;
-- the report queries that follow re-impersonate a real user.
--
-- Money: 012's header constraints hold (discount = 0, net_amount =
-- total_amount - discount). sale_items is intentionally NOT seeded - none of
-- the benchmarked functions read it, and report_sales_window sums the header's
-- net_amount directly.

begin;

-- Fixed identities (valid v4-shaped uuids) so a run is reproducible.
--   1111...0001  the bench store
--   1111...00a1  shop admin    -> auth_store_id() resolves to the store
--   1111...00b1  platform admin -> is_platform_admin() is true

-- 1) the store + a perpetual pro licence
insert into public.stores (id, name, time_zone)
values ('11111111-1111-4111-8111-000000000001', 'Bench Store', 'Africa/Cairo')
on conflict (id) do nothing;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values ('11111111-1111-4111-8111-000000000001', 'BENCH-LIC', 'pro', null)
on conflict (store_id) do nothing;

-- 2) shop admin (auth identity + staff row)
insert into auth.users (id, email, username)
values ('11111111-1111-4111-8111-0000000000a1', 'shop@bench.local', 'shopadmin')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, store_id, is_active)
values ('11111111-1111-4111-8111-0000000000a1', 'shopadmin', 'x',
        '11111111-1111-4111-8111-000000000001', true)
on conflict (id) do nothing;

-- 3) platform admin (auth identity + platform_admins row)
insert into auth.users (id, email, username)
values ('11111111-1111-4111-8111-0000000000b1', 'plat@bench.local', 'platadmin')
on conflict (id) do nothing;

insert into public.platform_admins (auth_uid, name)
values ('11111111-1111-4111-8111-0000000000b1', 'Bench Platform')
on conflict (auth_uid) do nothing;

-- 4) 50k sales, spread over ~730 days, ~80% paid.
--    The ledger sync trigger is disabled for the load; amount_paid is written
--    to equal the payment rows so header and ledger agree once it is re-enabled.
alter table public.sale_payments disable trigger sale_payments_sync;

insert into public.sales
  (id, invoice_no, store_id, user_id, total_amount, discount, net_amount,
   amount_paid, payment_method, order_date)
select
  ('22222222-2222-4222-8222-' || lpad(i::text, 12, '0'))::uuid,
  'BENCH-' || lpad(i::text, 8, '0'),
  '11111111-1111-4111-8111-000000000001',
  '11111111-1111-4111-8111-0000000000a1',
  v.amt, 0, v.amt,
  case when (i % 5) < 4 then v.amt else 0 end,
  (array['cash','instapay','wallet','card'])[(i % 4) + 1],
  now() - (random() * interval '730 days')
from generate_series(1, 50000) as i,
     lateral (select (50 + (i % 50) * 37.5)::numeric(10,2) as amt) v;

-- 5) one payment row per PAID sale (amount = that sale's net_amount, > 0)
insert into public.sale_payments (sale_id, amount, method, paid_at, store_id)
select s.id, s.net_amount, s.payment_method, s.order_date::date, s.store_id
from public.sales s
where s.store_id = '11111111-1111-4111-8111-000000000001'
  and s.amount_paid > 0;

alter table public.sale_payments enable trigger sale_payments_sync;

commit;

-- sanity: the seeded scale
select
  (select count(*) from public.sales
     where store_id = '11111111-1111-4111-8111-000000000001') as sales,
  (select count(*) from public.sale_payments
     where store_id = '11111111-1111-4111-8111-000000000001') as payments,
  (select min(order_date)::date from public.sales
     where store_id = '11111111-1111-4111-8111-000000000001') as first_day,
  (select max(order_date)::date from public.sales
     where store_id = '11111111-1111-4111-8111-000000000001') as last_day;
