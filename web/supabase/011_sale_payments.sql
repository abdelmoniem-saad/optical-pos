-- LensyPOS — 011: sale payment ledger (cash / wallet / instapay, split payments)
-- =================================================================================
-- Until now an invoice could record only ONE payment: sales.amount_paid (a
-- number) and sales.payment_method (one free-text label). Real shops take the
-- same order in several tenders — e.g. 600 cash + 400 InstaPay — and collect
-- the remaining balance LATER, possibly in yet another tender. This migration
-- adds:
--
--   • sale_payments   — ONE row per money received against an invoice:
--                         remaining = sales.net_amount - SUM(sale_payments.amount)
--   • backfill        — every legacy sale with amount_paid > 0 gets ONE dated
--                       row (guarded by NOT EXISTS, same trick as 003), so old
--                       invoices keep their history and the math above stays
--                       universally true.
--   • sync trigger    — sales.amount_paid is RECOMPUTED from the ledger after
--                       any ledger change. The ledger is the source of truth;
--                       the column stays as the denormalized read-model that
--                       reports and badges already use.
--   • create_sale_order(..., p_payments) — checkout writes the payment lines in
--                       the SAME transaction as the sale/items/exams. The old
--                       3-arg signature is DROPPED first: two same-name
--                       functions where one has all-default parameters make
--                       every PostgREST call ambiguous (PGRST203).
--   • rx/frame photo columns on the header insert — the client already sends
--                       them inside p_sale; the 002 version silently dropped
--                       them (latent bug, fixed here).
--
-- Tenancy/licensing: 008 runs BEFORE this file, so this file installs the
-- tenant_fill_store_id trigger and the RLS v2 tenant+license policies for the
-- new table itself — grace/expired stores can READ payments but not WRITE,
-- exactly like every other store-scoped table.
--
-- Method is free TEXT (default 'cash'): a future method (e.g. 'card') is a
-- one-line app change, not another migration. Known keys: cash | wallet | instapay.
--
-- Idempotent: safe to run multiple times.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
--   (Tip: snapshot the schema FIRST with `supabase db dump` — you are about to
--    change it; the dump only reads the database.)

-- ============================================================
-- 1) TABLE
-- ============================================================

create table if not exists public.sale_payments (
    id uuid primary key default uuid_generate_v4(),
    sale_id uuid not null references public.sales(id) on delete cascade,
    amount decimal(10, 2) not null check (amount > 0),
    method text not null default 'cash',      -- 'cash' | 'wallet' | 'instapay' (free text on purpose)
    note text,
    paid_at date not null default current_date,
    recorded_by uuid references auth.users(id) on delete set null, -- who took the money
    store_id uuid,                            -- filled by trigger from auth_store_id()
    created_at timestamptz not null default now()
);

create index if not exists sale_payments_sale_idx
    on public.sale_payments (sale_id, paid_at);
create index if not exists sale_payments_store_idx
    on public.sale_payments (store_id);

-- ============================================================
-- 2) BACKFILL legacy amount_paid (before RLS, like 003 does)
-- ============================================================

insert into public.sale_payments (sale_id, amount, method, paid_at, note, store_id)
select s.id,
       s.amount_paid,
       lower(coalesce(nullif(trim(s.payment_method), ''), 'cash')),
       coalesce((s.order_date)::date, current_date),
       'Backfill from legacy amount_paid',
       s.store_id
from public.sales s
where s.amount_paid > 0
  and not exists (
    select 1 from public.sale_payments sp
    where sp.sale_id = s.id
  );

-- ============================================================
-- 3) TRIGGERS
-- ============================================================

-- 3a) Auto-fill store_id from the signed-in user's store (same function 008
--     installs on every other store-scoped table).
drop trigger if exists tenant_fill_store_id on public.sale_payments;
create trigger tenant_fill_store_id before insert on public.sale_payments
    for each row execute function public.tenant_fill_store_id();

-- 3b) Keep sales.amount_paid == SUM(its ledger rows) after every ledger change
--     (insert / update / delete). SECURITY INVOKER on purpose: the same RLS
--     rules that allowed the payment write must allow the header update.
create or replace function public.sync_sale_amount_paid() returns trigger
language plpgsql as $$
declare
    v_sale uuid;
begin
    v_sale := coalesce(new.sale_id, old.sale_id);
    update public.sales s
       set amount_paid = (
             select coalesce(sum(sp.amount), 0)
             from public.sale_payments sp
             where sp.sale_id = v_sale
           )
     where s.id = v_sale;
    return null;
end $$;

drop trigger if exists sale_payments_sync on public.sale_payments;
create trigger sale_payments_sync
    after insert or update or delete on public.sale_payments
    for each row execute function public.sync_sale_amount_paid();

-- ============================================================
-- 4) RLS v2 — same tenant + license policies 008 generates in its loop
-- ============================================================

alter table public.sale_payments enable row level security;
alter table public.sale_payments force row level security;

drop policy if exists lensy_authenticated_all on public.sale_payments;
drop policy if exists lensy_tenant_read on public.sale_payments;
drop policy if exists lensy_tenant_insert on public.sale_payments;
drop policy if exists lensy_tenant_update on public.sale_payments;
drop policy if exists lensy_tenant_delete on public.sale_payments;

-- READ: own store + license read-ok (active or grace), or platform admin.
create policy lensy_tenant_read on public.sale_payments for select to authenticated
using (
    public.is_platform_admin()
    or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id)))
);
-- INSERT: license must be ACTIVE (grace/expired stores cannot write).
create policy lensy_tenant_insert on public.sale_payments for insert to authenticated
with check (
    public.is_platform_admin()
    or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
);
-- UPDATE: old row readable, new row writable.
create policy lensy_tenant_update on public.sale_payments for update to authenticated
using (
    public.is_platform_admin()
    or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id)))
)
with check (
    public.is_platform_admin()
    or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
);
-- DELETE: license must be ACTIVE.
create policy lensy_tenant_delete on public.sale_payments for delete to authenticated
using (
    public.is_platform_admin()
    or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
);

-- ============================================================
-- 5) create_sale_order: superset of the 002 version + payment lines
-- ============================================================

-- Drop the old 3-arg overload FIRST so only the 4-arg signature remains
-- (otherwise PostgREST cannot resolve calls made with 3 parameters).
drop function if exists public.create_sale_order(jsonb, jsonb, jsonb);

create or replace function public.create_sale_order(
  p_sale     jsonb,
  p_items    jsonb default '[]'::jsonb,
  p_exams    jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb
) returns public.sales
language plpgsql
security invoker
as $$
declare
  v_in      public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale    public.sales;
  v_inv     text := v_in.invoice_no;
  v_max_num int;
begin
  -- If invoice_no is null, empty, or already taken, compute next available 6-digit invoice
  if v_inv is null or trim(v_inv) = '' or exists (select 1 from public.sales where invoice_no = v_inv) then
    select coalesce(max(
      case
        when invoice_no ~ '^\d+$' then invoice_no::int
        else 0
      end
    ), 0) + 1
    into v_max_num
    from public.sales;

    loop
      v_inv := lpad(v_max_num::text, 6, '0');
      exit when not exists (select 1 from public.sales where invoice_no = v_inv);
      v_max_num := v_max_num + 1;
    end loop;
  end if;

  insert into public.sales
    (invoice_no, customer_id, user_id, total_amount, discount, net_amount,
     amount_paid, payment_method, order_date, delivery_date, doctor_name, lab_status,
     rx_image_path, frame_image_path)
  values
    (v_inv, v_in.customer_id, v_in.user_id, v_in.total_amount,
     v_in.discount, v_in.net_amount, v_in.amount_paid,
     coalesce(v_in.payment_method, 'Cash'), coalesce(v_in.order_date, now()),
     v_in.delivery_date, v_in.doctor_name, v_in.lab_status,
     v_in.rx_image_path, v_in.frame_image_path)
  returning * into v_sale;

  -- line items
  insert into public.sale_items (sale_id, product_id, qty, unit_price, total_price, name)
  select v_sale.id, r.product_id, r.qty, r.unit_price, r.total_price, r.name
  from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- one negative stock movement per line
  insert into public.stock_movements (product_id, qty, type, ref_no, note, created_at)
  select r.product_id, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
  from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- examinations
  insert into public.order_examinations
    (sale_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info,
         r.frame_info, r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_sale.doctor_name), r.image_path
  from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  -- payment lines (one per tender). The sale_payments_sync trigger recomputes
  -- sales.amount_paid from these rows, so the header can never disagree with
  -- the ledger even if a client sends a mismatched amount_paid.
  insert into public.sale_payments (sale_id, amount, method, note, paid_at, store_id, recorded_by)
  select v_sale.id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         r.note,
         coalesce(r.paid_at, current_date),
         v_sale.store_id,
         coalesce(r.recorded_by, auth.uid())
  from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
  where r.amount is not null and r.amount > 0;

  return v_sale;
end$$;

grant execute on function public.create_sale_order(jsonb, jsonb, jsonb, jsonb) to authenticated;
