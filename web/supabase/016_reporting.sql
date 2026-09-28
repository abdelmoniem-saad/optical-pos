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
-- 6) grants
-- ============================================================
-- SECURITY DEFINER is required (these aggregate across rows the caller may not
-- be able to page through), and they take NO store argument on purpose: the
-- store comes from auth_store_id(), so a caller cannot ask for another shop's
-- report. None of them can write.
grant execute on function public.report_window(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_sales_window(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_top_customers(timestamptz, timestamptz, int) to authenticated;
grant execute on function public.report_payment_mix(timestamptz, timestamptz) to authenticated;
grant execute on function public.report_voided_count(timestamptz, timestamptz) to authenticated;

