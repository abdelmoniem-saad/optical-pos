-- ===========================================================================
-- 028 - a partial refund on a live invoice
--
-- WHY THIS EXISTS. 013 made a sale reversible, but only in one shape: void_sale
-- reverses EVERYTHING - every tender mirrored as a refund, the invoice marked
-- voided. That is right for "this whole sale was a mistake". It is wrong for
-- the far more common "the customer returned one item" or "we overcharged by
-- 50" - a sale that is otherwise fine and must STAY on the books, with only
-- part of the money going back. There was no way to express that, so a shop's
-- only recourse was to void a correct invoice and re-key it, losing the audit
-- thread.
--
-- WHAT A REFUND IS, AND IS NOT. A refund writes ONE negative sale_payments row
-- (kind = 'refund') on a NAMED tender. The sale is NOT voided - voided_at stays
-- null, the items stay sold, the invoice stays in History. Only the money
-- moves, and the ledger's own sync trigger (013) recomputes sales.amount_paid
-- from the sum, so the header follows automatically. This is deliberately the
-- opposite of void_sale, which DOES flip voided_at: two questions - "undo the
-- whole thing" and "give some money back" - with two different answers.
--
-- THE CEILING IS PER-TENDER, NOT JUST PER-SALE. You cannot refund more cash
-- than was taken in cash. Guarding only against the sale total would let a
-- caller refund 500 'cash' on a sale paid 300 cash + 400 wallet - a real
-- over-refund on a specific tender that a total-only check would wave through.
-- So the guard is the net paid on THAT method, which is the honest invariant.
--
-- THE PERMISSION IS ITS OWN CODE, SEEDED NOT TO BE DEAD. history.refund is
-- distinct from history.void (a correction to a live invoice) and from delete
-- (which 013 revoked from everybody) - the same "separate decisions" reasoning
-- 024 used for closing.edit. A new code no role holds is a feature that is
-- greyed out with no explanation (021's trap), so it is seeded to every role
-- and person that already holds history.void, through a callable seed function
-- (024's pattern) - a shop that adds a manager role later runs the seed and
-- gets the same grants.
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 027).
-- ===========================================================================

-- ============================================================
-- 1) the permission code
-- ============================================================
-- `name` is what the Access Control matrix shows beside the tick box, so it is
-- written for whoever is looking at the matrix.
insert into public.permissions (code, name, description)
values ('history.refund', 'Refund a sale',
        'Return part of a live sale''s money on one tender, without voiding the invoice')
on conflict (code) do nothing;

-- ============================================================
-- 2) seed it to whoever already holds history.void
-- ============================================================
-- A FUNCTION, not a bare INSERT, for 024's reason: a gate builds a fresh
-- database and seeds its own fixtures AFTER the migrations run, so a
-- migration-time grant has nothing to act on and cannot be tested. Callable
-- again by hand for a role created later. Returns the number of grants it made
-- so "nothing to do" is distinguishable from "ran and did nothing".
create or replace function public.seed_refund_permission()
returns integer
language sql security definer set search_path = public as $$
  with created as (
    insert into public.role_permissions (role_id, permission_id)
    select rp.role_id, np.id
      from public.role_permissions rp
      join public.permissions granted on granted.id = rp.permission_id
      join public.permissions np on np.code = 'history.refund'
     where granted.code = 'history.void'
    on conflict (role_id, permission_id) do nothing
    returning 1
  ), created_users as (
    insert into public.user_permissions (user_id, permission_id, allow)
    select up.user_id, np.id, up.allow
      from public.user_permissions up
      join public.permissions granted on granted.id = up.permission_id
      join public.permissions np on np.code = 'history.refund'
     where granted.code = 'history.void'
    on conflict (user_id, permission_id) do nothing
    returning 1
  )
  select (select count(*)::int from created)
       + (select count(*)::int from created_users) $$;

-- Executable by the migration runner and by hand. It only ADDS grants, and only
-- to holders of history.void, so it cannot widen anybody's reach beyond that.
grant execute on function public.seed_refund_permission() to authenticated;
select public.seed_refund_permission();

-- ============================================================
-- 3) refund_sale: one tender, part of the money, sale stays
-- ============================================================
-- Modeled on void_sale (014's version, which added require_perm as the first
-- statement) - the #105 lesson: diff against the file that CURRENTLY defines
-- the pattern, not the one you remember. The differences from void_sale are
-- exactly three: it does NOT touch voided_at, it takes an amount and a method
-- rather than mirroring every tender, and its ceiling is per-tender.
create or replace function public.refund_sale(
  p_sale_id uuid,
  p_amount  numeric,
  p_method  text,
  p_reason  text default null
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_sale      public.sales;
  v_store     uuid;
  v_paid_here numeric;
begin
  perform public.require_perm('history.refund');
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  select * into v_sale
    from public.sales
   where id = p_sale_id
     for update;
  if not found then
    raise exception 'sale not found';
  end if;
  if v_sale.store_id is distinct from v_store and not public.is_platform_admin() then
    raise exception 'sale belongs to another store';
  end if;
  -- A voided sale has already refunded everything through void_sale; refunding
  -- it again would pay the customer twice. Void is the whole-sale answer.
  if v_sale.voided_at is not null then
    raise exception 'sale is already voided';
  end if;

  -- THE CEILING, PER TENDER. The net taken on THIS method: payments minus any
  -- refunds already made on it. A total-sale check would let a caller refund
  -- 500 cash on a 300-cash + 400-wallet sale; this does not.
  select coalesce(sum(sp.amount), 0) into v_paid_here
    from public.sale_payments sp
   where sp.sale_id = p_sale_id
     and sp.method = p_method;
  if p_amount > v_paid_here then
    raise exception 'refund of % exceeds the % paid on %',
      p_amount, v_paid_here, p_method
      using errcode = '22023';
  end if;

  -- The negative row. The 013 sync trigger recomputes sales.amount_paid from
  -- the ledger sum on insert, so no money column is written here - the header
  -- follows the ledger, which is the whole design.
  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  values
    (p_sale_id, -p_amount, p_method, 'refund',
     'Refund ' || coalesce(v_sale.invoice_no, '')
       || case when p_reason is null or trim(p_reason) = '' then ''
              else ': ' || p_reason end,
     now(), v_sale.store_id, auth.uid())
  returning sale_id into p_sale_id;

  -- Re-read so the returned header carries the amount_paid the trigger computed.
  select * into v_sale from public.sales where id = p_sale_id;
  return v_sale;
end $$;

revoke execute on function public.refund_sale(uuid, numeric, text, text) from public, anon;
grant  execute on function public.refund_sale(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- 4) stamp THIS migration (020 makes an unstamped file a red build)
-- ============================================================
select public.record_schema_version(28, 'partial single-tender refund on a live invoice: refund_sale(), history.refund permission');
