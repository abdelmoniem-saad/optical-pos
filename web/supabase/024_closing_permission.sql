-- LensyPOS — 024: closing the till gets its own permission
-- ============================================================
-- 023 gated `close_shift` on `reports.edit`, and that was a reasonable first
-- answer. It is the wrong one, for a reason this migration exists to fix.
--
-- THE PROBLEM
-- -----------
-- A shop is going to want two different people to be able to close the till:
-- a manager who reviews the numbers, and a cashier who counts the drawer at
-- closing time. `reports.edit` ties those together through the Reports screen,
-- which is the whole opposite of what most shops want — Reports shows revenue,
-- top customers and the payment mix, and the plan here is for it to be
-- manager-only.
--
-- So granting a cashier the ability to close the till would hand them Reports
-- as a side effect. That is not a permission model; it is a coincidence
-- someone noticed later. A cashier counting money and recording a variance is
-- normal. A cashier reading the shop's revenue is a decision.
--
-- THE FIX
-- -------
-- Two codes of its own — `closing.view` (may see the day's figures) and
-- `closing.edit` (may record a close) — and `close_shift` now requires
-- `closing.edit`.
--
-- THE SEED, AND WHY IT IS A FUNCTION
-- ---------------------------------
-- A new permission code that no role holds is a feature that is dead on
-- arrival: the shop pastes this, the button is greyed out, and nothing says
-- why. That is exactly the trap 021 walked into, where the first platform admin
-- had no supported way to be created. So the codes are seeded to every role and
-- every person that already holds `reports.edit`, and to nothing else.
--
-- The first draft of this migration did that seeding as bare INSERTs at
-- migration time, and its gate could not test it — **a gate builds a fresh
-- database and creates its own fixtures AFTER the migrations have run**, so
-- migration-time seeding has nothing to act on. 019 hit the identical wall with
-- its lab-dwell backfill, and the roadmap records it: *"The backfill itself is
-- not gated, and cannot be."*
--
-- Declaring that here would have been giving up on a check worth having. So the
-- seed is a FUNCTION, called once by this file and callable again by hand — a
-- shop that adds a new "manager" role later can run it and get the same grants
-- 024 gave the roles that existed on the day it was pasted. That turns an
-- untestable migration statement into a testable, re-runnable operation, and it
-- is the whole reason this file is shaped this way.
--
-- `role_permissions.value` is deliberately not consulted. The app reads
-- `select permissions(code) from role_permissions` and treats every row as a
-- grant (permissions.tsx:91-98), so a row IS the grant and nothing else. This
-- matches how every other role grant in the system is written.
--
-- Idempotent throughout: both inserts are `on conflict do nothing`, the
-- function is `create or replace`, and re-pasting changes no existing grant.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run. Safe to re-paste;
-- to grant a role created later, call the seed by hand:
--     select public.seed_closing_permissions();

-- ============================================================
-- 1) the codes
-- ============================================================
-- `name` is what the Access Control matrix shows beside the tick box, so it is
-- written for whoever is looking at the matrix, not for a developer.
insert into public.permissions (code, name, description)
values
  ('closing.view', 'Close shift - view',
     'See what the drawer should hold for a day, without recording a close.'),
  ('closing.edit', 'Close shift - record',
     'Count the drawer and record the close. Cannot be edited afterwards.')
on conflict (code) do nothing;

-- ============================================================
-- 2) the seed, as a callable function
-- ============================================================
-- Returns how many grants it created, so a caller can tell "nothing to do" from
-- "ran and did nothing" by reading a number rather than parsing a NOTICE.
create or replace function public.seed_closing_permissions()
returns integer
language sql security definer set search_path = public as $$
  with created as (
    -- Roles that may edit reports get BOTH closing codes.
    insert into public.role_permissions (role_id, permission_id)
    select rp.role_id, np.id
      from public.role_permissions rp
      join public.permissions granted on granted.id = rp.permission_id
      join public.permissions np on np.code in ('closing.view', 'closing.edit')
     where granted.code = 'reports.edit'
    on conflict (role_id, permission_id) do nothing
    returning 1
  ), created_users as (
    -- Same for grants made to a PERSON rather than through a role.
    insert into public.user_permissions (user_id, permission_id, allow)
    select up.user_id, np.id, up.allow
      from public.user_permissions up
      join public.permissions granted on granted.id = up.permission_id
      join public.permissions np on np.code in ('closing.view', 'closing.edit')
     where granted.code = 'reports.edit'
    on conflict (user_id, permission_id) do nothing
    returning 1
  )
  select (select count(*)::int from created)
       + (select count(*)::int from created_users) $$;

-- Executable by the migration runner and by a superuser running it by hand. It
-- only ever ADDS grants, and only to code that grants reports.edit, so it cannot
-- widen anybody's access beyond what they already had.
revoke execute on function public.seed_closing_permissions() from public, anon, authenticated;

-- ============================================================
-- 3) run it
-- ============================================================
select public.seed_closing_permissions();

-- ============================================================
-- 4) close_shift now requires closing.edit
-- ============================================================
-- Redefined, not edited: 023 is applied to a live database, and this repository
-- forbids editing an applied migration so an old install and a fresh one
-- converge on the same schema.
create or replace function public.close_shift(
  p_from         timestamptz,
  p_to           timestamptz,
  p_counted_cash numeric,
  p_note         text default null
) returns public.shift_closes
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_r     record;
  v_out   public.shift_closes;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  -- A close is a privileged write, and since 024 that privilege is closing.edit
  -- rather than reports.edit: closing the till and reading the shop's revenue
  -- are separate decisions, and a cashier who counts the drawer at 7pm should
  -- not need Reports to do it.
  perform public.require_perm('closing.edit');

  if p_from is null or p_to is null or p_to <= p_from then
    raise exception
      'close_shift: the window must run forwards, and both ends are required (from %, to %)',
      p_from, p_to;
  end if;

  -- A close with no counted drawer is not a close. Requiring it is what stops
  -- "I'll fill this in later", which is how a cash trail goes missing.
  if p_counted_cash is null then
    raise exception
      'close_shift: a close needs the counted cash - a shift cannot be closed without it';
  end if;

  if exists (
    select 1 from public.shift_closes
     where store_id = v_store and from_at = p_from and to_at = p_to
  ) then
    raise exception
      'close_shift: this window has already been closed - a close is an event, not an edit, so close the next window instead';
  end if;

  -- z_report is tenant-scoped by auth_store_id(), which still reads the caller's
  -- JWT here, so these figures are the CALLER's store and nobody else's.
  select * into v_r from public.z_report(p_from, p_to);

  insert into public.shift_closes
    (store_id, closed_by, from_at, to_at, counted_cash, expected_cash,
     expected_by_tender, expected_total, variance, order_count,
     prescription_count, void_count, refund_total, lab_delivered, note)
  values
    (v_store, auth.uid(), p_from, p_to, p_counted_cash, v_r.expected_cash,
     v_r.expected_by_tender, v_r.expected_total,
     round(p_counted_cash - v_r.expected_cash, 2),
     v_r.order_count, v_r.prescription_count, v_r.void_count,
     v_r.refund_total, v_r.lab_delivered, nullif(btrim(p_note), ''))
  returning * into v_out;

  return v_out;
end $$;

grant execute on function public.close_shift(timestamptz, timestamptz, numeric, text)
  to authenticated;

-- ============================================================
-- 5) record this migration's own number
-- ============================================================
-- Required: check-migrations-stamp.sh makes an unstamped migration a RED BUILD,
-- and 020's assert_versions_recorded() raises during the paste.
select public.record_schema_version(24, 'closing.view / closing.edit, so closing the till is not Reports');
