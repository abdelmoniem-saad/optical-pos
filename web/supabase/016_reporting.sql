-- LensyPOS — 016: reporting in the database
-- ============================================================
-- The Reports screen used to download EVERY sale header in the store and sum
-- it in JavaScript. Two problems, one of them money:
--
--   1. It counted VOIDED sales as revenue. `void_sale` deliberately leaves
--      `net_amount` intact so the audit trail reads true, so summing the column
--      without excluding the void made the shop look richer by exactly the
--      amount it gave back. (Fixed on the client in the same release; these
--      functions make it true in the database too, so the number is enforced
--      rather than remembered.)
--
--   2. The payload grew without bound. A few thousand invoices is fine; at
--      200k it is a multi-megabyte download and a stalled tab, and the top-5
--      customer list was a full sort in the browser.
--
-- These functions return a FIXED-SIZE payload no matter how much history
-- exists, and they scope themselves to the caller's store, so a future
-- developer cannot forget either filter.
--
-- Requires 008 (auth_store_id) and 013 (voided_at / sales_live_idx).
-- Idempotent: create or replace.
-- REQUIRES NOTHING ELSE. Safe to re-run after a half-applied paste.

-- ============================================================
-- 1) the shared window helper
-- ============================================================
-- One definition of "the caller's store, optionally within a window", so no
-- report can disagree with another about whose money it is counting.
--
-- Note the EXCLUSIVE upper bound. A caller passing a bare date
-- ('2026-09-28') must get the whole day; against a timestamptz column that
-- string means midnight at the START of the day, and `<=` would silently drop
-- every payment after midnight. `is null` means "no upper bound".
create or replace function public.report_window(p_from timestamptz, p_to timestamptz)
returns table (store_id uuid, from_at timestamptz, to_at timestamptz)
language sql stable security definer set search_path = public as $$
  select public.auth_store_id(),
         p_from,
         case when p_to is null then null
              else (p_to at time zone 'UTC')::date + 1
         end::timestamptz
$$;

-- ============================================================
-- 2) totals for a period
-- ============================================================
-- Revenue, paid, balance, order count and the two lab counters, in ONE pass
-- over the index instead of N passes over a downloaded array.
create or replace function public.report_sales_window(p_from timestamptz, p_to timestamptz)
returns table (
  revenue      numeric,
  paid         numeric,
  balance_due  numeric,
  order_count  bigint,
  pending_lab  bigint,
  ready_lab    bigint
)
language sql stable security definer set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to)),
       s as (
         select coalesce(sum(x.net_amount), 0)    as revenue,
                coalesce(sum(x.amount_paid), 0)   as paid,
                count(*)                           as order_count,
                count(*) filter (
                  where x.lab_status in ('Not Started', 'In Lab', 'In Progress')
                )                                 as pending_lab,
                count(*) filter (
                  where x.lab_status = 'Ready'
                )                                 as ready_lab
           from public.sales x, w
          where x.store_id = w.store_id
            -- THE exclusion. A void is not revenue, is not an order, and is
            -- not a job in the lab. `sales_live_idx` is a partial index on
            -- exactly this predicate, so it costs nothing.
            and x.voided_at is null
            and (w.from_at is null or x.order_date >= w.from_at)
            and (w.to_at   is null or x.order_date <  w.to_at)
         )
  select s.revenue,
         s.paid,
         s.revenue - s.paid,
         s.order_count,
         s.pending_lab,
         s.ready_lab
    from s
$$;

-- ============================================================
-- 3) top customers, aggregated in SQL
-- ============================================================
-- Was: download every sale, build a Map in JS, sort, slice(0, 5).
create or replace function public.report_top_customers(
  p_from timestamptz,
  p_to   timestamptz,
  p_limit int default 5
)
returns table (customer_id uuid, full_name text, revenue numeric)
language sql stable security definer set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to))
  select s.customer_id,
         c.name,
         sum(s.net_amount)
    from public.sales s
    join public.customers c on c.id = s.customer_id, w
   where s.store_id = w.store_id
     and s.voided_at is null
     and s.customer_id is not null
     and (w.from_at is null or s.order_date >= w.from_at)
     and (w.to_at   is null or s.order_date <  w.to_at)
   group by s.customer_id, c.name
   order by sum(s.net_amount) desc, c.name
   limit least(greatest(coalesce(p_limit, 5), 1), 50)
$$;

-- ============================================================
-- 4) money received per tender (the cash-up view)
-- ============================================================
-- Sums the LEDGER, so refunds (negative rows, migration 013) net out against
-- the payments they reversed - which is what a cash drawer actually does. A
-- void therefore removes the money from the tender it came in on, rather than
-- becoming an adjustment the cashier has to remember.
create or replace function public.report_payment_mix(p_from timestamptz, p_to timestamptz)
returns table (method text, total numeric)
language sql stable security definer set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to))
  select p.method, sum(p.amount)
    from public.sale_payments p, w
   where p.store_id = w.store_id
     and (w.from_at is null or p.paid_at >= w.from_at)
     and (w.to_at   is null or p.paid_at <  w.to_at)
   group by p.method
   order by sum(p.amount) desc, p.method
$$;

-- ============================================================
-- 5) a void summary, so the client can show what it excluded
-- ============================================================
-- Without this, "excluded N voided invoices" would need a second full
-- download just to count.
create or replace function public.report_voided_count(p_from timestamptz, p_to timestamptz)
returns table (voided_count bigint, voided_net numeric)
language sql stable security definer set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to))
  select count(*), coalesce(sum(s.net_amount), 0)
    from public.sales s, w
   where s.store_id = w.store_id
     and s.voided_at is not null
     and (w.from_at is null or s.order_date >= w.from_at)
     and (w.to_at   is null or s.order_date <  w.to_at)
$$;

-- ============================================================
-- 7) ONE definition of "today"
-- ============================================================
-- Three screens disagreed, and in UTC+2 a sale made at 1:00 AM counted as
-- yesterday on Reports (which used toISOString(), i.e. UTC) and as today on
-- History (which used the browser's local date). The cash-up panel was worse:
-- it filtered `paid_at` with a bare date against a timestamptz column, and
-- `lte('2026-09-28')` means midnight at the START of that day, so every
-- payment after midnight was silently dropped.
--
-- The store's zone is a column, not a client guess: a tablet set to the wrong
-- timezone, or a cashier abroad, must not move the shop's books.
alter table public.stores
  add column if not exists time_zone text not null default 'Africa/Cairo';

-- Per-store override in settings wins, so a store that moves is one UPDATE
-- rather than a migration. Falls back to the column, then to UTC.
create or replace function public.store_time_zone()
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.value from public.settings s
      where s.store_id = public.auth_store_id() and s.key = 'time_zone'),
    (select st.time_zone from public.stores st where st.id = public.auth_store_id()),
    'UTC'
  )
$$;

-- The half-open UTC instants of the store's LOCAL day. Both bounds are
-- timestamptz, so no caller has to think about what a bare date means against
-- a timestamp column - the ambiguity that made the cash-up panel wrong.
create or replace function public.store_day_range(p_day date default null)
returns table (from_at timestamptz, to_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_zone text := public.store_time_zone();
  v_day  date := coalesce(p_day, (now() at time zone v_zone)::date);
begin
  return query
  select (v_day::text || ' 00:00:00')::timestamp at time zone v_zone,
         ((v_day + 1)::text || ' 00:00:00')::timestamp at time zone v_zone;
end $$;

-- report_window() now honours the store's zone for a bare DATE, instead of
-- assuming the string meant UTC. This is the same 016 function, redefined so
-- that a caller passing '2026-09-28' gets that whole day in CAIRO time.
create or replace function public.report_window(p_from timestamptz, p_to timestamptz)
returns table (store_id uuid, from_at timestamptz, to_at timestamptz)
language sql stable security definer set search_path = public as $$
  select public.auth_store_id(),
         p_from,
         case when p_to is null then null
              else ((p_to at time zone 'UTC')::date + 1
                    )::timestamp at time zone public.store_time_zone()
         end::timestamptz
$$;

grant execute on function public.store_time_zone() to authenticated;
grant execute on function public.store_day_range(date) to authenticated;

-- SECURITY DEFINER is required (these aggregate across rows the caller may not
-- be able to page through), and they take NO store argument on purpose: the
-- store comes from auth_store_id(), so a caller cannot ask for another shop's
-- report. None of them can write.
grant execute on function public.report_window(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_sales_window(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_top_customers(timestamptz, timestamptz, int) to authenticated;
grant execute on function public.report_payment_mix(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_voided_count(timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 9) search that can find people
-- ============================================================
-- The browser searched with `or(name.ilike.%term%, phone.ilike.%term%)`, which
-- has two problems:
--
--   1. It could not be escaped safely, so the term was stripped of `,()` before
--      use. Searching "Ahmed (Cairo)" became "Ahmed   Cairo" and returned
--      nothing - silently, with no error, which is the worst way to fail.
--   2. `ilike '%term%'` cannot use a btree index, so every keystroke is a
--      sequential scan of the table.
--
-- pg_trgm makes a substring search indexable, and moving the term into a
-- function means no filter string is assembled in the browser at all - so the
-- or-syntax injection surface goes away with the escaping problem.
create extension if not exists pg_trgm with schema extensions;

do $$
declare
  t text;
begin
  foreach t in array array['customers.name', 'customers.phone',
                           'inventory.name', 'inventory.sku',
                           'sales.invoice_no'] loop
    execute format(
      'create index if not exists %I on public.%I using gin (%I extensions.gin_trgm_ops)',
      'idx_trgm_' || split_part(t, '.', 1) || '_' || split_part(t, '.', 2),
      split_part(t, '.', 1), split_part(t, '.', 2));
  end loop;
end $$;

-- One term, one argument, no string concatenation. p_limit is clamped so a
-- caller cannot ask for the whole table. The `like` escape is passed as a
-- parameter, so a term containing % or _ matches literally instead of acting
-- as a wildcard the user never typed.
create or replace function public.search_text(p_term text, p_limit int default 6)
returns table (
  kind text,
  id uuid,
  label text,
  detail text,
  happened_at timestamptz
)
language sql stable security definer set search_path = public, extensions as $$
  with v as (select public.auth_store_id() as s,
                    nullif(btrim(coalesce(p_term, '')), '') as t,
                    least(greatest(coalesce(p_limit, 6), 1), 25) as n)
  select 'customer', c.id, c.name, coalesce(c.phone, ''), c.created_at
    from public.customers c, v
   where v.t is not null and length(v.t) >= 2
     and c.store_id = v.s
     and (c.name ilike '%' || v.t || '%' or c.phone ilike '%' || v.t || '%')
  union all
  select 'product', i.id, i.name, coalesce(i.sku, ''), i.created_at
    from public.inventory i, v
   where v.t is not null and length(v.t) >= 2
     and i.store_id = v.s
     and (i.name ilike '%' || v.t || '%' or i.sku ilike '%' || v.t || '%')
  union all
  select 'sale', s.id, coalesce(s.invoice_no, ''), '', s.order_date
    from public.sales s, v
   where v.t is not null and length(v.t) >= 2
     and s.store_id = v.s
     and s.invoice_no ilike '%' || v.t || '%'
  order by 5 desc nulls last
  limit (select n from v)
$$;

grant execute on function public.search_text(text, int) to authenticated;


