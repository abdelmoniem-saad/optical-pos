-- LensyPOS — 023: the day/shift close (Z report)
-- ============================================================
-- A shop's daily question is not "what did I sell?" — the Reports screen
-- answers that. It is "how much should be in the drawer, and is it?" This
-- migration makes that answerable, and makes the answer keepable.
--
-- WHY IT IS CHEAP NOW (the roadmap said "now cheap", and it was right)
-- ------------------------------------------------------------------
-- Every piece it needs already exists, which is why this is a day rather than a
-- week:
--   * 013 made paid_at a timestamptz and gave sale_payments a `kind`
--     (payment | refund), so money can be expressed as going out.
--   * 016 added store_day_range() and a family of windowed report functions.
--   * 018 demonstrated a windowed aggregate over the ledger.
--   * 022 gave sales a kind, so an order count here means what it says.
--
-- THE ONE PROPERTY THIS BUILDS ON
-- -------------------------------
-- A void is NOT filtered out of the cash figures. It does not need to be. 013's
-- void_sale writes a compensating NEGATIVE payment on the same tender, so the
-- original money and its reversal cancel inside the sum. 016's report_payment_mix
-- already relies on this. It is the right shape for a drawer: what you want is
-- what the drawer should hold, and a voided invoice leaves the drawer exactly as
-- empty as the sale left it full.
--
-- CLOSING IS AN EVENT, NEVER AN EDIT
-- ----------------------------------
-- shift_closes is append-only. Nothing updates a closed row and nothing deletes
-- one - same principle as void_sale. A shop that closes wrongly cannot quietly
-- correct it; they close again and both answers stand. That is what makes "was
-- the drawer right last Tuesday?" answerable months later, which is the entire
-- reason to keep the table at all.
--
-- WHO MAY CLOSE
-- -------------
-- Reading the live report needs no permission beyond tenancy, exactly like every
-- other report function: the roadmap's Phase 3 decision is that resolve_can is
-- NOT wired into ordinary READS, because gating reads on the permission matrix
-- locks a whole shop out of their own numbers over one mistyped grant.
--
-- CLOSING is a privileged WRITE, so it calls require_perm('reports.edit'). That
-- code already exists in the catalogue, deliberately: inventing a new code such
-- as 'reports.close' would ship a permission that NO role holds, and the feature
-- would be dead on arrival until somebody granted it by hand - the same trap as
-- 021, where the first platform admin had no supported way to be created. If a
-- shop wants day-close to be a separate, tighter grant later, that is a data
-- change to the catalogue, not a schema change.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
--
-- Idempotent: the table is `if not exists`, the functions are `create or
-- replace`, and every policy is dropped before it is created. Re-pasting adds
-- nothing and changes no existing close.

-- ============================================================
-- 1) the ledger of closes
-- ============================================================
create table if not exists public.shift_closes (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  closed_at          timestamptz not null default now(),
  closed_by          uuid references auth.users(id) on delete set null,
  from_at            timestamptz not null,
  to_at              timestamptz not null,
  -- What the cashier counted, and what the ledger said should be there. Both are
  -- stored: recomputing `expected` later would let a re-priced sale rewrite
  -- history, which is the one thing an audit trail must not allow.
  counted_cash       numeric(12, 2) not null,
  expected_cash      numeric(12, 2) not null,
  expected_by_tender jsonb not null default '{}'::jsonb,
  expected_total     numeric(12, 2) not null,
  variance           numeric(12, 2) not null,
  -- Counters, so a close is a summary rather than only a cash figure.
  order_count        bigint not null default 0,
  prescription_count bigint not null default 0,
  void_count         bigint not null default 0,
  refund_total       numeric(12, 2) not null default 0,
  lab_delivered      bigint not null default 0,
  note               text,
  constraint shift_closes_window_ck check (to_at > from_at),
  -- A window may be closed exactly once. The check in close_shift() gives a
  -- readable message; this is the backstop for the double-tap that the message
  -- cannot catch, because two taps can both pass the check before either writes.
  constraint shift_closes_window_uniq unique (store_id, from_at, to_at)
);

create index if not exists shift_closes_store_closed_idx
  on public.shift_closes (store_id, closed_at desc);

-- RLS: readable by the store that owns it, writable only through close_shift().
-- There is deliberately no INSERT/UPDATE/DELETE policy, so a direct write is
-- refused by the same machinery that protects every other financial table.
alter table public.shift_closes enable row level security;

drop policy if exists lensy_shift_closes_read on public.shift_closes;
create policy lensy_shift_closes_read on public.shift_closes
  for select to authenticated
  using (store_id = public.auth_store_id() or public.is_platform_admin());

-- Belt and braces alongside the missing policies: a direct INSERT would also be
-- refused by RLS, but saying so in the grants means the intent is legible in
-- the dump rather than inferred from an absence.
revoke insert, update, delete on public.shift_closes from anon, authenticated;

-- ============================================================
-- 2) z_report: what the drawer SHOULD hold
-- ============================================================
-- Read-only, tenant-scoped by report_window() exactly like report_sales_window.
-- The window is half-open [from, to) on paid_at for money and order_date for
-- orders, because that is the convention 016 established and getting it wrong is
-- what made the cash-up panel come back empty.
create or replace function public.z_report(p_from timestamptz, p_to timestamptz)
returns table (
  expected_cash      numeric,
  expected_by_tender jsonb,
  expected_total     numeric,
  order_count        bigint,
  prescription_count bigint,
  void_count         bigint,
  refund_total       numeric,
  lab_delivered      bigint
)
language sql stable security definer set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to)),
  in_window as (
    -- One definition of "in the window", written once. It appears in three of the
    -- CTEs below and a subtle difference between them would show up as a report
    -- that disagrees with itself.
    select p.method, p.amount
      from public.sale_payments p, w
     where p.store_id = w.store_id
       and (w.from_at is null or p.paid_at >= w.from_at)
       and (w.to_at   is null or p.paid_at <  w.to_at)
  ),
  pay as (
    select coalesce(sum(amount), 0) as total,
           coalesce(sum(amount) filter (where lower(method) = 'cash'), 0) as cash,
           -- Refunds are stored negative, so negate to report a positive figure.
           coalesce(-sum(amount) filter (where amount < 0), 0) as refunds
      from in_window
  ),
  tenders as (
    select coalesce(jsonb_object_agg(method, total), '{}'::jsonb) as by_tender
      from (select method, sum(amount) as total from in_window group by method) t
  ),
  cnt as (
    select count(*) filter (where s.kind = 'sale')        as orders,
           count(*) filter (where s.kind = 'prescription') as presc,
           count(*) filter (where s.voided_at is not null) as voids
      from public.sales s, w
     where s.store_id = w.store_id
       and (w.from_at is null or s.order_date >= w.from_at)
       and (w.to_at   is null or s.order_date <  w.to_at)
  ),
  lab as (
    -- "Delivered" means the job REACHED Received inside the window, so a job
    -- finished on Sunday and handed over on Monday counts on Monday. Keyed on
    -- the status-change stamp, not order_date, which is 019's whole point.
    select count(*) as delivered
      from public.sales s, w
     where s.store_id = w.store_id
       and s.lab_status = 'Received'
       and (w.from_at is null or s.lab_status_changed_at >= w.from_at)
       and (w.to_at   is null or s.lab_status_changed_at <  w.to_at)
  )
  select pay.cash, tenders.by_tender, pay.total,
         cnt.orders, cnt.presc, cnt.voids, pay.refunds, lab.delivered
    from pay, tenders, cnt, lab
$$;

-- ============================================================
-- 3) close_shift: record the event
-- ============================================================
-- SECURITY DEFINER because it writes a table the caller has no INSERT privilege
-- on. That is the point: the only way to close a shift is through this function,
-- which is where the permission check, the window check and the duplicate check
-- live. auth.uid() still resolves to the CALLER inside a definer function - it
-- reads the JWT, not current_user - so closed_by is the person who closed it.
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

  -- A close is a privileged write, so it is gated like every other one.
  perform public.require_perm('reports.edit');

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

grant execute on function public.z_report(timestamptz, timestamptz) to authenticated;
grant execute on function public.close_shift(timestamptz, timestamptz, numeric, text)
  to authenticated;

-- ============================================================
-- 4) record this migration's own number
-- ============================================================
-- Required: check-migrations-stamp.sh makes an unstamped migration a RED BUILD,
-- and 020's assert_versions_recorded() raises during the paste.
select public.record_schema_version(23, 'day/shift close: z_report() and an append-only shift_closes ledger');
