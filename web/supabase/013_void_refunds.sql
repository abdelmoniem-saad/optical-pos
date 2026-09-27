-- LensyPOS — 013: reversible sales, undeletable ledger (PHASED_ROADMAP Phase 2)
-- ============================================================
-- Phase 1 made the database the authority on what a sale IS. Phase 2 makes it
-- the authority on what may UNDO one. Today any signed-in staff member can
-- `DELETE /rest/v1/sales` and erase the shop's history outright (008 grants
-- lensy_tenant_delete on every store table, keyed only on store + licence), and
-- a mis-keyed invoice can never be reversed at all: sale_payments even forbids
-- a negative amount, so money cannot go back.
--
-- What changes for the shop:
--   • a sale can be VOIDED from History in a few taps. Voiding is an event
--     (voided_at / voided_by / void_reason), never an edit or a delete: the
--     header, the lines, the exams and the original payment rows all stay.
--   • voiding hands the stock back (or not, the cashier chooses) and mirrors
--     every tender as a REFUND row, so the cash-up per payment method in
--     Reports stays truthful after a void.
--   • direct DELETE is gone from the seven money tables. Deleting a sale line
--     by hand could desync the ledger from the header; the only way to change
--     a sale is the RPC below, which re-prices it server-side first.
--   • re-checkout became ATOMIC. useUpdateSaleFull used to delete and reinsert
--     items, exams, movements and payments over five separate round-trips - a
--     failure in the middle left a half-written order (threat T6). It is now
--     one update_sale_order() call, priced by the same core as checkout.
--   • the money columns on `sales` are LEDGER-OWNED. Only the checkout /
--     re-checkout RPCs and the ledger's own sync trigger may write
--     total_amount / discount / net_amount / amount_paid; a direct UPDATE is
--     refused, so the header can no longer drift from sale_payments.
--   • sale_payments gained `kind` (payment | refund) and `paid_at` became a
--     timestamptz, so two payments on the same day are distinguishable.
--   • line-level discounts with a reason (sale_items.discount +
--     discount_reason), priced by the same server core as everything else.
--   • stock_movements gained a real vocabulary (`kind`) alongside the legacy
--     free-text `type`, so a restock, a sale, a purchase and a correction can
--     be told apart.
--
-- REQUIRES 012. Idempotent: safe to run more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 012).
--
-- The client switch that goes with this (useUpdateSaleFull -> update_sale_order,
-- useUpdateSale -> no money columns, the History void button) ships in the same
-- release: once the delete policies are dropped, a client still deleting those
-- rows itself will start failing.
-- ============================================================

-- ============================================================
-- 1) the ledger can express money going BACK
-- ============================================================

-- kind: 'payment' (money in) or 'refund' (money out). Free text on purpose, like
-- `method`, so a future kind needs no migration.
alter table public.sale_payments
  add column if not exists kind text not null default 'payment';

-- paid_at was a DATE: two payments on one day were indistinguishable and a
-- shift/day close could not be built on it. Widening is lossless.
alter table public.sale_payments
  alter column paid_at type timestamptz using paid_at::timestamptz;

-- amount > 0 -> amount <> 0. Zero is still meaningless, negative is a refund.
alter table public.sale_payments drop constraint if exists sale_payments_amount_check;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'sale_payments_amount_nonzero'
       and conrelid = 'public.sale_payments'::regclass
  ) then
    alter table public.sale_payments
      add constraint sale_payments_amount_nonzero check (amount <> 0) not valid;
  end if;
  begin
    alter table public.sale_payments validate constraint sale_payments_amount_nonzero;
  exception when check_violation then
    raise warning 'lensy: sale_payments_amount_nonzero is NOT valid - zero-amount ledger rows exist; delete them, then validate again';
  end;
end $$;

-- ============================================================
-- 2) a sale can be voided (an event, never a delete)
-- ============================================================

alter table public.sales add column if not exists voided_at  timestamptz;
alter table public.sales add column if not exists voided_by  uuid references auth.users(id) on delete set null;
alter table public.sales add column if not exists void_reason text;

-- Reports/History filter on this; a partial index keeps it cheap.
create index if not exists sales_live_idx
  on public.sales (store_id, order_date desc)
  where voided_at is null;

-- ============================================================
-- 3) line-level discount, with a reason
-- ============================================================
-- total_price keeps meaning qty * unit_price (012's validated constraint), so
-- the discount is its own column and lands in the HEADER discount. Net is
-- preserved exactly, exactly as a negotiated order is.

alter table public.sale_items
  add column if not exists discount numeric(10, 2) not null default 0;
alter table public.sale_items
  add column if not exists discount_reason text;

do $$
declare rec record;
begin
  for rec in
    select * from (values
      ('sale_items_discount_nonneg',  'check (discount >= 0)'),
      ('sale_items_discount_le_total', 'check (discount <= total_price)')
    ) as t(cname, expr)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = rec.cname and conrelid = 'public.sale_items'::regclass
    ) then
      execute format('alter table public.sale_items add constraint %I %s not valid',
                     rec.cname, rec.expr);
    end if;
    if exists (
      select 1 from pg_constraint
       where conname = rec.cname and conrelid = 'public.sale_items'::regclass
         and not convalidated
    ) then
      begin
        execute format('alter table public.sale_items validate constraint %I', rec.cname);
      exception when check_violation then
        raise warning 'lensy: % is NOT valid - existing sale_items violate it', rec.cname;
      end;
    end if;
  end loop;
end $$;

-- ============================================================
-- 4) stock_movements gets a real vocabulary
-- ============================================================
-- The legacy `type` column stays (the app still writes it) but is no longer the
-- only meaning. `kind` is normalised from it by a trigger, so every writer -
-- the checkout RPC, the POS +/- buttons, adjustments, legacy client code -
-- lands on a known value without a single client change.

create table if not exists public.stock_movement_kinds (
  code  text primary key,
  label text not null
);

insert into public.stock_movement_kinds (code, label) values
  ('initial',     'Opening stock'),
  ('sale',        'Sold at the till'),
  ('void_restock','Returned by a void'),
  ('adjustment',  'Manual correction'),
  ('purchase',    'Received from a supplier'),
  ('transfer',    'Moved between warehouses'),
  ('other',       'Unclassified')
on conflict (code) do nothing;

alter table public.stock_movements
  add column if not exists kind text
  references public.stock_movement_kinds(code) on update cascade;

create or replace function public.normalise_movement_kind() returns trigger
language plpgsql as $$
declare
  v_type text := lower(trim(coalesce(new.type, '')));
begin
  new.kind := case
    when v_type in ('initial', 'opening', 'new')                 then 'initial'
    when v_type in ('sale', 'pos', 'pos_sale', 'pos sale')       then 'sale'
    when v_type in ('return', 'void', 'void_restock', 'restock') then 'void_restock'
    when v_type in ('adjustment', 'adjust', 'correction', 'fix') then 'adjustment'
    when v_type in ('purchase', 'purchase_in', 'receipt', 'in')  then 'purchase'
    when v_type = 'transfer'                                     then 'transfer'
    else 'other'
  end;
  return new;
end $$;

drop trigger if exists stock_movement_kind on public.stock_movements;
create trigger stock_movement_kind
  before insert or update of type on public.stock_movements
  for each row execute function public.normalise_movement_kind();

-- Backfill the rows that predate the column.
update public.stock_movements set type = type where kind is null;

-- ============================================================
-- 5) the money columns on `sales` are ledger-owned
-- ============================================================
-- Before, any client could `update sales set amount_paid = 0` and the header
-- would silently disagree with the ledger that 011 works to keep honest. The
-- guard allows a money write only from inside a transaction that has raised
-- the lensy.money_write flag - the checkout RPC, the re-checkout RPC, and the
-- ledger's own sync trigger.

create or replace function public.guard_sale_money() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('lensy.money_write', true), '') = '1' then
    return new;
  end if;
  if new.total_amount is distinct from old.total_amount
     or new.discount     is distinct from old.discount
     or new.net_amount   is distinct from old.net_amount
     or new.amount_paid  is distinct from old.amount_paid then
    raise exception 'money columns are ledger-owned: change the sale through the checkout RPC or sale_payments'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists sales_money_guard on public.sales;
create trigger sales_money_guard
  before update on public.sales
  for each row execute function public.guard_sale_money();

-- Forward-fix of 011's sync trigger: it is the ONE writer allowed to move
-- amount_paid, so it raises the flag around its own UPDATE and lowers it again.
create or replace function public.sync_sale_amount_paid() returns trigger
language plpgsql as $$
declare
  v_sale uuid;
begin
  v_sale := coalesce(new.sale_id, old.sale_id);
  perform set_config('lensy.money_write', '1', true);
  update public.sales s
     set amount_paid = (
           select coalesce(sum(sp.amount), 0)
             from public.sale_payments sp
            where sp.sale_id = v_sale
         )
   where s.id = v_sale;
  perform set_config('lensy.money_write', '', true);
  return null;
end $$;

-- ============================================================
-- 6) price_cart(): the server-pricing core, shared by both RPCs
-- ============================================================
-- Extracted from 012's create_sale_order so re-checkout is priced by exactly
-- the same rules as checkout (the Phase 1 gate re-proves checkout after this
-- refactor). Locks every product in the cart in id order - two registers can
-- never deadlock - verifies the client's line prices against the catalog, and
-- turns the ONE money input that survives (the client's net) into an honest
-- total/discount pair.

create or replace function public.price_cart(
  p_items  jsonb,
  p_net    numeric,
  p_allow_negative_stock boolean
) returns table (
  total_amount numeric,
  discount     numeric,
  net_amount   numeric,
  prices       jsonb,
  items_sum    numeric
)
language plpgsql
set search_path = public
as $$
declare
  v_prices   jsonb := '{}'::jsonb;
  v_line     record;
  v_cat      numeric;
  v_cat_name text;
  v_stock    integer;
  v_items    numeric := 0;
  v_net      numeric;
  v_total    numeric;
  v_discount numeric;
  v_line_net numeric;
begin
  -- 1) lock every product, collect the prices the DB will actually charge
  for v_line in
    select r.product_id, sum(r.qty)::integer as qty
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
     group by r.product_id
     order by r.product_id
  loop
    select i.name, i.sale_price, i.stock_qty
      into v_cat_name, v_cat, v_stock
      from public.inventory i
     where i.id = v_line.product_id
       for update of i;
    if not found then
      raise exception 'unknown product in cart';
    end if;

    if not p_allow_negative_stock and coalesce(v_stock, 0) < v_line.qty then
      raise exception 'insufficient stock: %', coalesce(v_cat_name, 'unknown product');
    end if;

    v_prices := v_prices || jsonb_build_object(v_line.product_id::text, coalesce(v_cat, 0));
  end loop;

  -- 2) validate every line against the catalog (T1)
  for v_line in
    select r.product_id, r.qty, r.unit_price, r.discount
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
  loop
    if coalesce(v_line.qty, 0) <= 0 then
      raise exception 'invalid line quantity';
    end if;
    v_cat := (v_prices ->> v_line.product_id::text)::numeric;
    if abs(coalesce(v_line.unit_price, 0) - v_cat) > 0.01 then
      select i.name into v_cat_name from public.inventory i where i.id = v_line.product_id;
      raise exception 'price changed: %', coalesce(v_cat_name, 'unknown product');
    end if;

    -- line-level discount: never more than the line is worth
    if coalesce(v_line.discount, 0) < 0 then
      raise exception 'negative line discount';
    end if;
    if coalesce(v_line.discount, 0) > v_line.qty * v_cat + 0.01 then
      select i.name into v_cat_name from public.inventory i where i.id = v_line.product_id;
      raise exception 'line discount exceeds the line: %', coalesce(v_cat_name, 'unknown product');
    end if;

    v_items := v_items + v_line.qty * v_cat;
  end loop;

  -- 3) the client's net is the only money input that survives
  v_net := coalesce(p_net, 0);
  if v_net < -0.01 then
    raise exception 'negative net amount';
  end if;
  v_net := round(v_net, 2);

  -- gross minus the line discounts already given
  v_line_net := v_items - coalesce((
    select sum(coalesce(r.discount, 0))
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
  ), 0);

  if v_net <= v_line_net + 0.01 then
    v_total    := v_items;
    v_discount := round(greatest(0, v_line_net - v_net), 2);
    v_net      := v_total - v_discount;
  else
    v_total    := v_net;
    v_discount := 0;
  end if;

  return query select v_total, v_discount, v_net, v_prices, v_items;
end $$;

-- ============================================================
-- 7) create_sale_order, now sharing the core and honouring line discounts
-- ============================================================
-- Dropped and recreated (not `create or replace`) so the old overloads cannot
-- linger beside the new one and make PostgREST calls ambiguous (PGRST203) -
-- the exact trap 011 and 012 both document.

drop function if exists public.create_sale_order(jsonb, jsonb, jsonb);
drop function if exists public.create_sale_order(jsonb, jsonb, jsonb, uuid);
drop function if exists public.create_sale_order(jsonb, jsonb, jsonb, jsonb, uuid);

create function public.create_sale_order(
  p_sale            jsonb,
  p_items           jsonb default '[]'::jsonb,
  p_exams           jsonb default '[]'::jsonb,
  p_payments        jsonb default '[]'::jsonb,
  p_idempotency_key uuid  default null
) returns public.sales
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_inv      text;
  v_allow    boolean;
  v_paid_hdr numeric;
  v_paid_led numeric;
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
    from public.price_cart(p_items,
                           coalesce(v_in.net_amount,
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
       rx_image_path, frame_image_path)
    values
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, v_in.user_id,
       t.total_amount, t.discount, t.net_amount, v_paid_hdr,
       coalesce(v_in.payment_method, 'Cash'),
       coalesce(v_in.order_date, now()), v_in.delivery_date, v_in.doctor_name,
       v_in.lab_status, v_in.rx_image_path, v_in.frame_image_path)
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

  return v_sale;
end $$;

-- ============================================================
-- 8) update_sale_order: an atomic, server-priced re-checkout
-- ============================================================
-- Replaces useUpdateSaleFull's five client-side round-trips (update header,
-- delete+insert items, delete+insert exams, delete+insert movements,
-- delete+insert payments). SECURITY DEFINER because it deletes rows and the
-- delete policies are dropped below - so it re-checks tenancy and the licence
-- itself, which is the whole point of funnelling deletes through SQL.

create or replace function public.update_sale_order(
  p_sale_id  uuid,
  p_sale     jsonb,
  p_items    jsonb default '[]'::jsonb,
  p_exams    jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb
) returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_in    public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale  public.sales;
  v_store uuid;
  v_allow boolean;
  v_paid  numeric;
  t       record;
begin
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
  if v_sale.voided_at is not null then
    raise exception 'sale is voided and can no longer be edited';
  end if;

  select s.allow_negative_stock into v_allow
    from public.stores s
   where s.id = v_store;
  if v_allow is null then
    v_allow := true;
  end if;

  select * into t
    from public.price_cart(p_items,
                           coalesce(v_in.net_amount,
                                    coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0)),
                           v_allow);

  v_paid := coalesce((
    select sum(r.amount)
      from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
     where r.amount is not null and r.amount <> 0
  ), 0);
  if v_paid < -0.01 then
    raise exception 'negative payment amount';
  end if;
  if v_paid > t.net_amount + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;

  -- Replace, in one transaction. Movements are matched on the sale's own
  -- (type 'sale' + ref_no), so a re-checkout nets out exactly the old lines.
  delete from public.sale_items         where sale_id = p_sale_id;
  delete from public.order_examinations where sale_id = p_sale_id;
  delete from public.sale_payments      where sale_id = p_sale_id;
  delete from public.stock_movements
   where type = 'sale' and ref_no = v_sale.invoice_no and store_id = v_sale.store_id;

  perform set_config('lensy.money_write', '1', true);
  update public.sales
     set total_amount = t.total_amount,
         discount     = t.discount,
         net_amount   = t.net_amount,
         payment_method = coalesce(v_in.payment_method, v_sale.payment_method),
         customer_id  = coalesce(v_in.customer_id, v_sale.customer_id),
         doctor_name  = coalesce(v_in.doctor_name, v_sale.doctor_name),
         delivery_date = v_in.delivery_date,
         lab_status   = case
                          when jsonb_array_length(p_exams) > 0
                            then coalesce(v_in.lab_status, 'Not Started')
                          else null
                        end,
         rx_image_path   = v_in.rx_image_path,
         frame_image_path = v_in.frame_image_path
   where id = p_sale_id;

  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name,
     discount, discount_reason)
  select p_sale_id, v_sale.store_id, r.product_id, r.qty,
         (t.prices ->> r.product_id::text)::numeric,
         r.qty * (t.prices ->> r.product_id::text)::numeric,
         r.name, coalesce(r.discount, 0), r.discount_reason
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_sale.store_id, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select p_sale_id, v_sale.store_id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_sale.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         coalesce(nullif(lower(trim(r.kind)), ''), 'payment'),
         r.note,
         coalesce(r.paid_at, now()),
         v_sale.store_id,
         coalesce(r.recorded_by, auth.uid())
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount <> 0;

  perform set_config('lensy.money_write', '', true);

  -- the ledger's own sync trigger has already recomputed amount_paid; re-read
  -- so the caller gets the authoritative header back.
  select * into v_sale from public.sales where id = p_sale_id;
  return v_sale;
end $$;

-- ============================================================
-- 9) void_sale: the reversal
-- ============================================================
-- Mirrors every payment as a refund row (per tender, so the cash-up per method
-- stays right) and optionally puts the stock back. Nothing is deleted.

create or replace function public.void_sale(
  p_sale_id uuid,
  p_reason  text,
  p_restock boolean default true
) returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale  public.sales;
  v_store uuid;
begin
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
  if v_sale.voided_at is not null then
    raise exception 'sale is already voided';
  end if;

  -- stock back on the shelf (the 012 trigger keeps inventory.stock_qty honest)
  if coalesce(p_restock, true) then
    insert into public.stock_movements
      (product_id, store_id, qty, type, ref_no, note, created_at)
    select si.product_id, v_sale.store_id, si.qty, 'return',
           v_sale.invoice_no,
           'Void ' || coalesce(v_sale.invoice_no, '') ||
             case when p_reason is null or trim(p_reason) = ''
                  then '' else ': ' || p_reason end,
           now()
      from public.sale_items si
     where si.sale_id = p_sale_id
       and si.product_id is not null
       and si.qty > 0;
  end if;

  -- every tender mirrored as a refund, so cash-up per method stays truthful
  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id,
         -sp.amount,
         sp.method,
         'refund',
         'Void ' || coalesce(v_sale.invoice_no, ''),
         now(),
         v_sale.store_id,
         auth.uid()
    from public.sale_payments sp
   where sp.sale_id = p_sale_id
     and sp.kind = 'payment'
     and sp.amount > 0;

  update public.sales
     set voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end $$;

-- ============================================================
-- 10) purchase-side deletes move into SQL too
-- ============================================================
-- The Suppliers screen deletes a purchase (with its items and payments) and a
-- single payment row. Those are financial tables too, so they get the same
-- treatment: a checked SECURITY DEFINER function instead of a raw DELETE.

create or replace function public.delete_purchase(p_purchase uuid) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;
  if not exists (
    select 1 from public.purchases
     where id = p_purchase
       and (store_id = v_store or public.is_platform_admin())
  ) then
    raise exception 'purchase not found in this store';
  end if;

  delete from public.purchase_items     where purchase_id = p_purchase;
  delete from public.purchase_payments where purchase_id = p_purchase;
  delete from public.purchases          where id = p_purchase;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.delete_purchase_payment(p_payment uuid) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  v_store := public.auth_store_id();
  if not (select public.license_write_ok(v_store)) and not public.is_platform_admin() then
    raise exception 'store licence does not allow writes';
  end if;
  if not exists (
    select 1
      from public.purchase_payments pp
      join public.purchases p on p.id = pp.purchase_id
     where pp.id = p_payment
       and (p.store_id = v_store or public.is_platform_admin())
  ) then
    raise exception 'payment not found in this store';
  end if;

  delete from public.purchase_payments where id = p_payment;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ============================================================
-- 11) revoke direct DELETE on the money tables
-- ============================================================
-- The remaining lensy_tenant_* policies (read/insert/update) are untouched, so
-- ordinary work is unaffected - only the destructive verb is gone, and it now
-- lives exclusively inside the checked functions above.

do $$
declare t text;
begin
  foreach t in array array[
    'sales','sale_items','sale_payments','stock_movements',
    'purchases','purchase_items','purchase_payments'
  ] loop
    execute format('drop policy if exists lensy_authenticated_all on public.%I', t);
    execute format('drop policy if exists lensy_tenant_delete on public.%I', t);
  end loop;
end $$;

-- ============================================================
-- 12) grants
-- ============================================================

grant execute on function public.price_cart(jsonb, numeric, boolean) to authenticated;
grant execute on function public.create_sale_order(jsonb, jsonb, jsonb, jsonb, uuid)
  to authenticated;
grant execute on function public.update_sale_order(uuid, jsonb, jsonb, jsonb, jsonb)
  to authenticated;
grant execute on function public.void_sale(uuid, text, boolean) to authenticated;
grant execute on function public.delete_purchase(uuid) to authenticated;
grant execute on function public.delete_purchase_payment(uuid) to authenticated;
grant execute on function public.available_stock(uuid) to authenticated;
grant execute on function public.next_invoice_no() to authenticated;
grant execute on function public.add_inventory_item(jsonb, integer) to authenticated;
