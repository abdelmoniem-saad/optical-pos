-- ===========================================================================
-- 027 - plan feature flags, finally read (T9: the last Phase 3 hole)
--
-- WHY THIS EXISTS. 008 created store_licenses.features (jsonb, default '{}',
-- ":44") and NOTHING has ever read it. max_staff is enforced in SQL (the
-- create-user decision counts seats in the database), but every OTHER plan
-- flag is a column that looks configurable and governs nothing - the exact
-- defect class this whole effort exists to remove. A vendor editing that
-- column in the Table Editor would change nothing.
--
-- THE ONE FEATURE ENFORCED HERE, AND WHY IT IS SAFE TO ADD NOW.
-- license_feature(name) reads the caller's OWN store's flags, and
-- platform_report_window (025) now refuses when 'platform_report' is off.
-- The consolidated report is already platform-admin-gated, so a flag on top
-- is defence-in-depth, never a lockout of a shop.
--
-- DEFAULT IS *ALLOWED*, AND THAT IS DELIBERATE. An absent flag reads true.
-- The alternative - default false, enable per store - would silently revoke
-- the platform report from every existing vendor the moment they paste this
-- file, because no store has the flag set yet. That is the 021 lesson (a
-- correct-looking function whose answer cannot be obtained through the only
-- channel available) reached from the other side. So the flag is OPT-OUT: a
-- store keeps every feature until its plan explicitly excludes one. A vendor
-- who wants to sell a tier WITHOUT consolidated reporting sets
--   features = features || '{"platform_report": false}'
-- and the database honours it. Nothing reads features for per-screen gating
-- yet; that UI is deferred, and adding it here would rebuild the very
-- "control that looks like it governs something" this migration removes.
--
-- WHY license_feature DOES NOT CHECK LICENSE LIVENESS. Whether the licence is
-- alive is license_read_ok / license_write_ok's job, and it is a different
-- question. This function answers only "is feature X in this store's plan".
-- The platform report does not require a live licence today (a vendor's own
-- store may be unlicensed and they can still consolidate), so folding
-- liveness in here would change that behaviour - a regression dressed as a
-- feature. Callers stack the checks they actually mean.
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 026).
-- ===========================================================================

-- ============================================================
-- 1) the reader: is feature X in this store's plan?
-- ============================================================
-- SECURITY DEFINER + STABLE, scoped to auth_store_id(), exactly like
-- my_store_license (014) - so calling it reveals nothing the caller could not
-- already read. store_licenses.store_id is UNIQUE (008), so there is no
-- ordering to get wrong: one licence per store.
--
-- Robust by construction: only the exact text 'true'/'false' is honoured, and
-- everything else - an absent key, a hand-typed 'yes', a missing licence row -
-- reads as ALLOWED. A malformed flag must not become a refusal that looks like
-- a permissions problem, and it must never abort a report on a cast error.
create or replace function public.license_feature(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
             when (l.features ->> p_name) = 'true'  then true
             when (l.features ->> p_name) = 'false' then false
             else true
           end
      from public.store_licenses l
     where l.store_id = public.auth_store_id()
  ), true)
$$;

-- Revoked from PUBLIC/anon first, then granted: the default PUBLIC execute
-- grant is how a function meant for signed-in callers ends up reachable
-- without a session.
revoke execute on function public.license_feature(text) from public, anon;
grant  execute on function public.license_feature(text) to authenticated;

-- ============================================================
-- 2) the enforcement: the platform report honours the flag
-- ============================================================
-- platform_report_window is REDEFINED here, and the diff that matters is
-- against 025 - the file that currently defines it, not 012 or anything
-- earlier. The ONLY change is the feature check, added directly under the
-- is_platform_admin() check so the two gates are visibly independent: a
-- non-admin is refused as 'platform admin only' regardless of the flag, and
-- an admin whose plan excludes the feature is refused with its own message.
-- create or replace PRESERVES the existing grants (revoke-from-public/anon,
-- grant-to-authenticated from 025), so they are not repeated here.
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

  -- SECOND, and independent: the vendor's own plan must include the feature.
  -- A platform admin whose account belongs to a store whose plan excludes
  -- consolidated reporting is refused here, not at the screen.
  if not public.license_feature('platform_report') then
    raise exception 'platform_report not enabled on this plan';
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

-- ============================================================
-- 3) stamp THIS migration (020 makes an unstamped file a red build)
-- ============================================================
select public.record_schema_version(27, 'plan feature flags read: license_feature(), platform report gated on platform_report');
