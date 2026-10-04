-- ===========================================================================
-- 025 - consolidated multi-store reporting (platform admins)
--
-- WHAT THIS IS. Every other report function in this repository is single-store
-- BY CONSTRUCTION: none of them takes a store argument, and the store comes from
-- auth_store_id(), so a caller cannot ask for another shop's numbers. That is
-- the right design for a POS. It is also, precisely, why a vendor cannot answer
-- "how are all my shops doing today?" - the one question a platform admin
-- exists to be able to ask.
--
-- THE SENSITIVITY, STATED PLAINLY. This is the first surface in the application
-- that shows one store's money to somebody who does not belong to that store.
-- Six phases of tenant work have been about KEEPING APART; this is the one place
-- that deliberately reaches across. That is why the gate is mostly about WHO MAY
-- CALL IT rather than about arithmetic:
--
--   * the check is inside the function, first statement, failing CLOSED - so an
--     unapplied or half-applied state refuses rather than leaking;
--   * execute is revoked from PUBLIC and from anon, so the refusal is not only
--     in the body: there is no route to the body at all without a session;
--   * every ordinary report is untouched. A shop admin still reads their own
--     store exactly as before (gate G-A3 proves the block is narrow, because a
--     gate that only proves "blocked" also passes against a function that breaks
--     every caller including the vendor).
--
-- ONE ROW PER STORE, ON THAT STORE'S OWN DAY
-- -------------------------------------------
-- "Today" is ambiguous across stores in different timezones. There are two
-- honest ways to answer it and this picks the second deliberately:
--
--   (a) one shared UTC window, every store scored against it. Simple, and it
--       produces a day boundary that matches NO shop's actual trading day - a
--       store in Cairo+3 opens three hours before the window the report calls
--       "today" starts.
--   (b) one row per store, each store scored against ITS OWN local day.
--
-- (b) is what a shopkeeper means by "today", and it makes the total row a plain
-- sum of rows that each mean something - rather than a number computed a second
-- way that can disagree with its own parts. The gate's Y4 fixture (one instant at
-- 22:00 UTC, the 20th in UTC and the 21st in Cairo) is what pins the choice: it
-- counts for the UTC store and not for the Cairo one, and G-A6 fails under (a).
--
-- VOIDS ARE EXCLUDED HERE - and that is the opposite of z_report, on purpose.
-- This is REVENUE, not a drawer. 016's report_sales_window excludes voided sales
-- from revenue and its partial index makes that free; z_report keeps them because
-- void_sale writes a compensating negative payment so the money cancels inside
-- the sum, which is the right shape for "what should be in the drawer". The two
-- answers are both correct and they are different questions. Do not "harmonise"
-- them: a future edit that made this function include voided sales would report
-- money the shop did not keep, and one that excluded them from z_report would
-- break the drawer.
--
-- Refunds are NOT special-cased. amount_paid is maintained from the ledger by
-- 011's sync trigger, so a refund has already come off the header, and revenue
-- (net_amount) is never affected by one.
-- ===========================================================================

-- ============================================================
-- 1) the store's zone, for a NAMED store
-- ============================================================
-- store_time_zone() resolves auth_store_id(), so it cannot answer for a store the
-- caller is not in - which is the whole point here. This is the same lookup with
-- the store passed in, and it deliberately exposes nothing but a timezone string.
create or replace function public.store_time_zone_for(p_store uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.value from public.settings s
      where s.store_id = p_store and s.key = 'time_zone'),
    (select st.time_zone from public.stores st where st.id = p_store),
    'UTC'
  )
$$;

revoke execute on function public.store_time_zone_for(uuid) from public, anon;
grant  execute on function public.store_time_zone_for(uuid) to authenticated;

-- ============================================================
-- 2) the index the cross-store scan needs
-- ============================================================
-- sales_live_idx and idx_sales_store_date both LEAD with store_id, so a filter on
-- order_date alone - which is what crossing every store requires - cannot use
-- either. Without this the report is a sequential scan of the whole table, at
-- exactly the scale the reporting phase (016) exists to avoid.
--
-- Plain CREATE INDEX, not CONCURRENTLY, for the same reason every other migration
-- here uses it: the hand-paste flow must not fail on a statement that is illegal
-- inside a transaction block, and re-running must be a no-op. On a very large
-- table an operator who cares about not blocking checkout can run this one
-- statement by hand as CONCURRENTLY and then re-paste the file.
create index if not exists idx_sales_order_date
  on public.sales (order_date desc);

-- ============================================================
-- 3) the report
-- ============================================================
create or replace function public.platform_report_window(p_day date default null)
returns table (
  store_id    uuid,
  store_name  text,
  time_zone   text,
  is_active   boolean,
  from_at     timestamptz,
  to_at       timestamptz,
  revenue     numeric,
  paid        numeric,
  order_count bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  -- FIRST statement, failing closed. Everything else in this file is arithmetic.
  if not public.is_platform_admin() then
    raise exception 'platform admin only';
  end if;

  return query
  with zone as (
    select s.id, s.name, s.is_active,
           public.store_time_zone_for(s.id) as tz
      from public.stores s
  ),
  bounds as (
    -- A NULL day means "that store's today", which is a different DATE for each
    -- store. Computing it here rather than once outside is the entire point.
    select zone.*, coalesce(p_day, (now() at time zone zone.tz)::date) as d
      from zone
  ),
  win as (
    -- Half-open instants in UTC, exactly like store_day_range: no caller has to
    -- think about what a bare date means against a timestamptz, which is the
    -- ambiguity that made the cash-up panel wrong in the first place.
    select bounds.*,
           (bounds.d::text || ' 00:00:00')::timestamp at time zone bounds.tz as from_at,
           ((bounds.d + 1)::text || ' 00:00:00')::timestamp at time zone bounds.tz as to_at
      from bounds
  )
  select win.id,
         win.name,
         win.tz,
         win.is_active,
         win.from_at,
         win.to_at,
         coalesce(sum(x.net_amount), 0)::numeric,
         coalesce(sum(x.amount_paid), 0)::numeric,
         count(x.id)::bigint
    from win
    -- LEFT JOIN, so a shop that sold nothing today is a row of zeros rather than
    -- a missing row: "0" and "we have no data for that shop" are different
    -- answers, and a vendor comparing shops needs to tell them apart.
    left join public.sales x
      on x.store_id = win.id
     and x.voided_at is null
     and x.order_date >= win.from_at
     and x.order_date <  win.to_at
   group by win.id, win.name, win.tz, win.is_active, win.from_at, win.to_at
   -- Busiest first, so the screen a vendor actually looks at needs no sorting.
   order by coalesce(sum(x.net_amount), 0) desc, win.name;
end $$;

-- Revoked from PUBLIC as well as anon: PostgreSQL grants EXECUTE on every new
-- function to PUBLIC by default, so an explicit revoke is the only thing standing
-- between an unauthenticated caller and this function. The in-body check is the
-- second line of defence, not the first.
revoke execute on function public.platform_report_window(date) from public, anon;
grant  execute on function public.platform_report_window(date) to authenticated;

-- ============================================================
-- 4) stamp THIS migration
-- ============================================================
-- 018 and 019 shipped without this and a fully-migrated shop was indistinguishable
-- from one stuck at 017: the drift check could not notice a version it never
-- received. scripts/check-migrations-stamp.sh now fails the build if a migration
-- from 017 onward omits this line.
select public.record_schema_version(25, 'consolidated multi-store reporting for platform admins');
