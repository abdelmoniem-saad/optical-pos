-- LensyPOS - 026: the licence window, and making the dates mean what a person thinks
-- =================================================================================
-- Two defects, both of which decide whether a shop may trade.
--
-- 1) `starts_at` EXISTED and was IGNORED. 008 created store_licenses.starts_at with
--    DEFAULT now() NOT NULL, and license_read_ok/license_write_ok never mentioned it.
--    So a licence scheduled to begin next month was reported ACTIVE today - the one
--    thing a start date is for. Correctness of the DATE was not the problem; the
--    column was simply inert.
--
-- 2) The expiry picker wrote a BARE 'YYYY-MM-DD' into a timestamptz, which Postgres
--    casts in the SESSION timezone at 00:00. A licence the vendor read as
--    "expires 2026-12-31" was therefore dead from the START of 31 December: every
--    shop silently lost a day, and nothing in the app said so. Phase 4 recorded
--    this exact trap for Reports (`lends`/bare-date comparison in the session zone);
--    here it sat on the one field that gates trading.
--
-- The fix is to stop letting a browser write the column at all. `set_license_window`
-- takes DATES - the thing a person actually picks - and converts them to instants in
-- the STORE's own timezone, which is the same store-local-day decision 016 made for
-- "today". `expires_at` becomes the EXCLUSIVE end of the chosen day, so "expires
-- the 31st" means through the end of the 31st, once, everywhere.
--
-- NOT fixing here, and the reason is worth stating: `features` jsonb. It is a plan
-- flag column that NOTHING reads - Phase 3 deferred it. Adding a UI that edits it
-- would rebuild exactly the defect this phase exists to remove: a control that
-- looks like it governs something and governs nothing. It stays untouched until
-- something enforces it.
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 025).

-- ============================================================
-- 1) the checks learn what `starts_at` means
-- ============================================================
-- `order by created_at desc limit 1` is gone, and deliberately: store_licenses has a
-- UNIQUE constraint on store_id (008), so there is exactly one licence per store and
-- the ordering was a fiction that implied otherwise. The UI reading
-- `store_licenses[0]` is therefore safe - I claimed it was not, from reading the TSX
-- without checking the constraint, and the constraint is what settles it.

create or replace function public.license_read_ok(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (is_revoked = false)
       and (starts_at <= now())
       and (expires_at is null or expires_at > now() - interval '30 days')
    from public.store_licenses
    where store_id = p_store
  ), false)
$$;

-- WRITE: active licence only. Expired = read-only (print/export), no writes.
create or replace function public.license_write_ok(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (is_revoked = false)
       and (starts_at <= now())
       and (expires_at is null or expires_at > now())
    from public.store_licenses
    where store_id = p_store
  ), false)
$$;

-- ============================================================
-- 2) my_license_state: one row, and an honest answer before the start date
-- ============================================================
-- 'pending' is new, and it is the whole point: a licence bought for next month is not
-- active, and the app has to be able to say so without inventing 'active'. The client
-- type gains 'pending' in the same commit; a state the database returns and the
-- browser cannot type is a state the banner will mishandle.

-- DROP FIRST, and not as an afterthought: `create or replace` cannot change a
-- function's RETURN type, so adding `starts_at` to the returned row makes the
-- create fail with "cannot change return type of existing function". Nothing in
-- the SQL warns of this; the local gate suite caught it. The trade is a brief
-- window in which the app's RPC does not exist, which the client's isMissingRpc
-- fallback already handles for exactly this reason.

drop function if exists public.my_license_state();

create or replace function public.my_license_state()
returns table (state text, plan text, starts_at timestamptz, expires_at timestamptz,
                store_name text)
language sql stable security definer set search_path = public, auth as $$
  select
    case
      when s.id is null then 'none'
      when l.id is null then 'none'
      when l.is_revoked then 'expired'
      when l.starts_at > now() then 'pending'
      when l.expires_at is null or l.expires_at > now() then 'active'
      when l.expires_at > now() - interval '30 days' then 'grace'
      else 'expired'
    end,
    l.plan,
    l.starts_at,
    l.expires_at,
    s.name
  from public.stores s
  left join public.store_licenses l on l.store_id = s.id
  where s.id = public.auth_store_id()
$$;

-- ============================================================
-- 3) set_license_window: dates in, instants out, platform admins only
-- ============================================================
-- SECURITY DEFINER so it can write a table whose RLS admits only platform admins,
-- but the check is repeated INSIDE as well: 025's lesson is that a function whose
-- only gate is RLS is a function whose gate is one policy edit away from gone.

create or replace function public.set_license_window(
  p_store      uuid,
  p_starts_on  date,
  p_expires_on date default null,
  p_plan       text default null,
  p_max_staff  integer default null,
  p_notes      text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_zone  text;
  v_start timestamptz;
  v_end   timestamptz;
  v_id    uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;

  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'no such store' using errcode = '22023';
  end if;

  if p_starts_on is null then
    raise exception 'start date is required' using errcode = '22023';
  end if;

  -- Null expiry is the perpetual licence 009 seeds, so it stays legal.
  if p_expires_on is not null and p_expires_on < p_starts_on then
    raise exception 'expiry date % is before start date %', p_expires_on, p_starts_on
      using errcode = '22023';
  end if;

  -- A date a person picked is a day in the SHOP's zone, not the vendor's. Cairo is
  -- SEASONAL - UTC+3 in summer, UTC+2 in winter - so anything but the store's own
  -- zone (or the wrong season) is off by an hour or a whole day.
  v_zone := public.store_time_zone_for(p_store);

  -- Start of the chosen local day.
  v_start := p_starts_on::timestamp at time zone v_zone;
  -- EXCLUSIVE end of the chosen local day: 'expires the 31st' must mean through the
  -- end of the 31st. Storing 23:59:59 would work until a leap second.
  v_end := case when p_expires_on is null then null
                else ((p_expires_on + 1)::timestamp at time zone v_zone) end;

  insert into public.store_licenses
    (store_id, license_key, plan, max_staff, starts_at, expires_at, notes)
  values (
    p_store,
    'STORE-' || left(p_store::text, 8),
    coalesce(p_plan, 'standard'),
    p_max_staff,
    v_start,
    v_end,
    p_notes
  )
  on conflict (store_id) do update
    set plan       = excluded.plan,
        max_staff  = excluded.max_staff,
        starts_at  = excluded.starts_at,
        expires_at = excluded.expires_at,
        notes      = excluded.notes
  -- is_revoked is DELIBERATELY not touched. The old date picker carried
  -- `is_revoked: false` in its update, so typing a new date into a revoked licence
  -- quietly un-revoked it. Editing dates and revoking are different decisions and
  -- now live in different functions, so neither can do the other's job.
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- 4) revoke / restore, as its own decision
-- ============================================================
create or replace function public.set_license_revoked(p_store uuid, p_revoked boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;

  -- Two different mistakes deserve two different messages: a store that does not
  -- exist, and a store that exists but was never licensed. Collapsing them into
  -- 'no such store' sends an operator looking in the wrong place.
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'no such store' using errcode = '22023';
  end if;

  update public.store_licenses
     set is_revoked = coalesce(p_revoked, false)
   where store_id = p_store
  returning id into v_id;

  if v_id is null then
    raise exception 'store has no license to revoke' using errcode = '22023';
  end if;

  return v_id;
end;
$$;

-- ============================================================
-- 5) a licence change is an auditable event
-- ============================================================
-- 014 attached audit_row() to eleven tables and not this one, so the vendor's licence
-- decisions - the one thing a shop would ask us to prove - were the one change with
-- no trail. Belt and braces: the trigger also catches the direct-table path that
-- 026 is moving away from.

drop trigger if exists audit_row_trigger on public.store_licenses;
create trigger audit_row_trigger after insert or update or delete on public.store_licenses
  for each row execute function public.audit_row();

-- ============================================================
-- 6) grants
-- ============================================================
-- revoked from PUBLIC/anon first, then granted: SECURITY DEFINER plus the default
-- PUBLIC execute grant is how a function meant for platform admins ends up callable
-- by anyone who can reach the API.

-- Explicit, because the function was just dropped and recreated: the drop took
-- its grants with it and `alter default privileges` is what silently restores
-- them. Written down rather than relied upon.
grant execute on function public.my_license_state() to authenticated;

revoke execute on function public.set_license_window(uuid, date, date, text, integer, text) from public;
revoke execute on function public.set_license_window(uuid, date, date, text, integer, text) from anon;
grant  execute on function public.set_license_window(uuid, date, date, text, integer, text) to authenticated;

revoke execute on function public.set_license_revoked(uuid, boolean) from public;
revoke execute on function public.set_license_revoked(uuid, boolean) from anon;
grant  execute on function public.set_license_revoked(uuid, boolean) to authenticated;

-- ============================================================
-- 7) the stamp (migration 020 makes this mandatory, and run #100 was the lesson)
-- ============================================================
select public.record_schema_version(26, 'licence window: starts_at honoured, store-local dates, audited revoke');
