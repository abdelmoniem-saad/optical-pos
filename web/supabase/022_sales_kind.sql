-- LensyPOS — 022: say what a sale IS, so "orders today" means what it says
-- ============================================================
-- useAddStandalonePrescription (data/sales.ts:1159) writes a `sales` row for a
-- prescription that has no cart items and no money. It is a real record — it
-- holds the exam, the customer and the doctor, and both History and the Lab
-- screen read it — but it is not a billable order, and nothing said so.
--
-- The revenue numbers are NOT wrong, and this migration does not "fix" them,
-- because they were never broken: 016's report_sales_window sums net_amount and
-- amount_paid, so a zero-total row contributes 0 to both. The old `PRESC-`
-- invoice namespace the roadmap worried about really is gone. So the damage is
-- narrower, and naming it is the point:
--
--   * order_count was `count(*)`, so "Orders today: 12" counted prescriptions
--     that no customer paid for.
--   * a prescription consumes an invoice number from the shared counter, so the
--     sequence has gaps that read like lost business.
--
-- WHAT THIS DOES
-- --------------
-- Adds sales.kind ('sale' | 'prescription'), validated inside the checkout RPC
-- rather than trusted from the browser, and excludes only prescriptions from
-- order_count. Everything else is deliberately untouched: revenue, paid,
-- balance_due and the two lab counters all still count the row, because a
-- prescription genuinely IS a job in the lab. Excluding it from those would be
-- over-correcting, and the gate asserts they were left alone.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
--
-- Idempotent: re-pasting re-adds nothing (every add is `if not exists`), the
-- backfill only touches rows still marked 'sale', and the two function
-- redefinitions are `create or replace` on unchanged signatures.

-- ============================================================
-- 1) the column
-- ============================================================
-- `default 'sale'` rather than a nullable column that has to be backfilled and
-- then constrained: an existing row, and every row the OLD client writes before
-- it is redeployed, is a sale. That is the right default for a column whose
-- absence means "nothing was claimed".
alter table public.sales
  add column if not exists kind text not null default 'sale';

-- ============================================================
-- 2) the constraint, not valid first
-- ============================================================
-- The repository's migration discipline: `not valid` so a legacy row that
-- somehow violates it is REPORTED rather than blocking the migration on a live
-- shop, then validated explicitly.
alter table public.sales
  drop constraint if exists sales_kind_check;
alter table public.sales
  add constraint sales_kind_check check (kind in ('sale', 'prescription')) not valid;

-- ============================================================
-- 3) the backfill — deliberately conservative
-- ============================================================
-- Only rows that are ALL of: zero total, no line items, no payment rows. Each
-- clause removes candidates rather than adds them, so the only way a real order
-- is mislabelled is if it has no items and no payments, which is what a
-- prescription looks like. A genuinely free order that somehow carries items is
-- left as 'sale', which is the safe direction to be wrong in: it inflates a
-- count rather than hiding a sale.
update public.sales s
   set kind = 'prescription'
 where s.kind = 'sale'
   and coalesce(s.net_amount, 0) = 0
   and coalesce(s.total_amount, 0) = 0
   and not exists (select 1 from public.sale_items i where i.sale_id = s.id)
   and not exists (select 1 from public.sale_payments p where p.sale_id = s.id);

-- Nothing above can produce a value outside the whitelist, so this passes; it is
-- here so a future edit that widens the backfill cannot leave the constraint
-- `not valid` forever.
alter table public.sales validate constraint sales_kind_check;

-- ============================================================
-- 4) the checkout RPC, re-declared to carry kind
-- ============================================================
-- `create or replace` on the SAME 5-argument signature, so nothing in the
-- browser changes and nothing needs dropping. The header INSERT lists its
-- columns explicitly (it always did), so this is the one place `kind` is
-- written on the checkout path.
--
-- The important part is that kind is NOT taken from p_sale. create_sale_order
-- exists precisely because it does not trust the browser — it re-prices the cart
-- and re-totals the header — and `jsonb_populate_record` would happily copy a
-- client-sent `kind` of anything at all. So it is whitelisted here, and further
-- constrained: a prescription must have no lines and no payments. That closes the
-- reverse tamper too — a client cannot relabel a real order as a prescription to
-- drop it out of order_count, because a real order has items.
--
-- The body below is 012's function unchanged apart from (a) the `kind` column in
-- the header insert and (b) step 4b. It is repeated rather than wrapped because
-- PostgreSQL has no "alter one statement inside a function", and the alternative —
-- a second entry point — would leave the untampered path reachable, which is the
-- thing that has to stop being reachable.
create or replace function public.create_sale_order(
  p_sale            jsonb,
  p_items           jsonb default '[]'::jsonb,
  p_exams           jsonb default '[]'::jsonb,
  p_payments        jsonb default '[]'::jsonb,
  p_idempotency_key uuid  default null
) returns public.sales
language plpgsql
security invoker
as $$
declare
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_inv      text;
  v_allow    boolean;
  v_paid_hdr numeric;
  v_paid_led numeric;
  v_kind     text := 'sale';
  t          record;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  -- Idempotency: a replayed checkout returns the sale it already created.
  if p_idempotency_key is not null then
    select * into v_sale
      from public.sales
     where store_id = v_store
       and idempotency_key = p_idempotency_key;
    if found then
      return v_sale;
    end if;
  end if;

  select s.allow_negative_stock into v_allow
    from public.stores s
   where s.id = v_store;
  if v_allow is null then
    v_allow := true;
  end if;

  select * into t
    from public.price_cart(p_items, coalesce(v_in.net_amount,
                                             coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0)),
                           v_allow);

  -- money in can never exceed money out
  v_paid_hdr := coalesce(v_in.amount_paid, 0);
  if v_paid_hdr < -0.01 then
    raise exception 'negative payment amount';
  end if;
  select coalesce(sum(r.amount), 0) into v_paid_led
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;
  if v_paid_hdr > t.net_amount + 0.01 or v_paid_led > t.net_amount + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;

  -- NEW IN 022. The kind, decided here rather than believed.
  --
  -- create_sale_order exists because it does not trust the browser, and
  -- jsonb_populate_record would happily copy a client-sent `kind` of anything at
  -- all - including a value the check constraint does not even accept. So it is
  -- whitelisted here, and a prescription is defined by the CART rather than by
  -- the claim: nothing worth charging, and no money in. That second condition is
  -- what closes the tamper that matters. A whitelist alone would let a client
  -- claim `prescription` on a real order and drop it out of order_count, hiding a
  -- sale. t.total_amount is the gross the catalog says the cart is worth, so a
  -- real order - even one discounted 100% to zero net - is still gross > 0 and
  -- stays a sale.
  if v_in.kind = 'prescription'
     and t.total_amount = 0
     and not exists (
       select 1 from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
        where r.amount is not null and r.amount <> 0)
  then
    v_kind := 'prescription';
  end if;

  -- invoice number: the wizard's reservation when still free, else the counter
  v_inv := nullif(trim(v_in.invoice_no), '');
  if v_inv is not null and exists (select 1 from public.sales where invoice_no = v_inv) then
    v_inv := null;
  end if;
  if v_inv is null then
    v_inv := public.next_invoice_no();
  end if;

  begin
    insert into public.sales
      (invoice_no, store_id, idempotency_key, customer_id, user_id,
       total_amount, discount, net_amount, amount_paid, payment_method,
       order_date, delivery_date, doctor_name, lab_status,
       rx_image_path, frame_image_path, kind)
    values
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, v_in.user_id,
       t.total_amount, t.discount, t.net_amount, v_paid_hdr,
       coalesce(v_in.payment_method, 'Cash'),
       coalesce(v_in.order_date, now()), v_in.delivery_date, v_in.doctor_name,
       v_in.lab_status, v_in.rx_image_path, v_in.frame_image_path, v_kind)
    returning * into v_sale;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select * into v_sale
        from public.sales
       where store_id = v_store
         and idempotency_key = p_idempotency_key;
      if found then
        return v_sale;
      end if;
    end if;
    raise;
  end;

  -- lines at CATALOG prices, with the line discount kept alongside
  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name,
     discount, discount_reason)
  select v_sale.id, v_store, r.product_id, r.qty,
         (t.prices ->> r.product_id::text)::numeric,
         r.qty * (t.prices ->> r.product_id::text)::numeric,
         r.name, coalesce(r.discount, 0), r.discount_reason
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_store, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, v_store, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_in.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select v_sale.id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         coalesce(nullif(lower(trim(r.kind)), ''), 'payment'),
         r.note,
         coalesce(r.paid_at, now()),
         v_store,
         coalesce(r.recorded_by, auth.uid())
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount <> 0;
end $$;

-- ============================================================
-- 5) the report, and ONLY order_count changes
-- ============================================================
-- Same signature, so the client and the 016 gate are unaffected. The single
-- change is count(*) -> count(*) filter (where kind = 'sale') for order_count.
--
-- The lab counters keep counting every live row on purpose. A prescription is a
-- genuine job waiting in the lab, and excluding it would understate the queue —
-- the same over-correction 016's own history warns about, when voided rows
-- inflated revenue and the fix nearly went in the wrong column. The gate asserts
-- both counters still include the prescription.
--
-- No `grant execute` here on purpose: `create or replace` keeps the privileges
-- 016 granted, so re-granting would be noise that hides a real mistake if the
-- signature ever did move.
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
                count(*) filter (
                  where x.kind = 'sale'
                )                                 as order_count,
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
-- 6) record this migration's own number
-- ============================================================
-- Required: check-migrations-stamp.sh makes an unstamped migration a RED BUILD,
-- and 020's assert_versions_recorded() raises during the paste.
select public.record_schema_version(22, 'sales.kind, and an order count that excludes prescriptions');


