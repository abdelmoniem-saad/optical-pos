-- LensyPOS — 003: supplier shipment payment ledger
-- ================================================
-- A shipment (a `purchases` row) is an amount the shop owes a supplier, paid
-- off over time in partial payments / deposits (e.g. every ~7 days). This
-- table records EACH payment with its date, so:
--
--   remaining = purchases.total_amount - SUM(purchase_payments.amount)
--
-- Legacy shipments that carry an amount_paid are backfilled ONCE as a dated
-- "Down payment" row, keeping the math above universally true.
--
-- Idempotent: safe to run multiple times.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

create table if not exists public.purchase_payments (
    id uuid primary key default uuid_generate_v4(),
    purchase_id uuid not null references public.purchases(id) on delete cascade,
    amount decimal(10, 2) not null,
    paid_at date not null default current_date,
    note text,
    created_at timestamptz not null default now()
);

create index if not exists purchase_payments_purchase_idx
    on public.purchase_payments (purchase_id, paid_at);

-- Backfill legacy down-payments (runs once per shipment, guarded by note).
insert into public.purchase_payments (purchase_id, amount, paid_at, note)
select p.id, p.amount_paid, (p.purchase_date)::date, 'Down payment'
from public.purchases p
where p.amount_paid > 0
  and not exists (
    select 1 from public.purchase_payments pp
    where pp.purchase_id = p.id and pp.note = 'Down payment'
  );

-- Same security model as 001_security_rls.sql:
-- authenticated staff can do everything, anon can do nothing.
alter table public.purchase_payments enable row level security;
alter table public.purchase_payments force row level security;
drop policy if exists lensy_authenticated_all on public.purchase_payments;
create policy lensy_authenticated_all on public.purchase_payments
    for all
    to authenticated
    using (true)
    with check (true);
