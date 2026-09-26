-- LensyPOS — 012: money & stock integrity (PHASED_ROADMAP Phase 1)
-- ============================================================
-- Turns create_sale_order from "record whatever the browser sent" into
-- "validate and recompute", gives stock a home in SQL, moves invoice
-- numbering into an atomic counter, and makes checkout idempotent.
--
-- What changes for the shop (nothing else moves):
--   • line prices ALWAYS come from inventory.sale_price - the cart is a
--     preview; a stale cart is refused with 'price changed: <name>' rather
--     than silently re-priced.
--   • the browser's NET is the only money input that survives: a negotiated,
--     round-up or free total is preserved exactly, and any amount below the
--     catalog sum is stored as an explicit, receipt-visible discount.
--   • stock is guarded inside the transaction when
--     stores.allow_negative_stock = false. The default is TRUE, keeping the
--     app's documented intentional overselling (POSContext 'record the sale
--     even when qty-on-hand is zero') until a store opts in.
--   • invoice numbers are drawn from invoice_counter via next_invoice_no()
--     (row-locked, atomic) - the client's Date.now() fallback can never fire
--     while this is installed. Numbers are RESERVED at cart entry, so
--     abandoned carts may leave gaps (accepted; gapless sequences only matter
--     with e-invoicing, which is deferred).
--   • resending the same checkout (double-tap, lost response) with the same
--     p_idempotency_key returns the SAME sale - never a second one.
--   • inventory.stock_qty is a trigger-maintained read model over
--     stock_movements (the ledger stays the source of truth), so the app can
--     stop downloading every movement row to display one number.
--
-- REQUIRES 011 (sale_payments type is referenced).
-- Idempotent: safe to run multiple times.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 011).
--
-- If the guarded VALIDATE below reports violating legacy rows it leaves them
-- NOT VALID (a WARNING names them) instead of blocking this paste. Find them
-- with:
--   select * from public.sales
--    where not (net_amount = total_amount - discount)
--       or discount > total_amount or discount < 0 or amount_paid < 0;
--   select * from public.sale_items
--    where qty <= 0 or unit_price < 0 or total_price <> qty * unit_price;
-- Fix the rows, then: alter table public.sales validate constraint sales_net_matches; (etc.)
-- ============================================================

-- ---------- 1) per-store oversell switch ----------
-- Default TRUE = today's behaviour. Set FALSE on a store to make checkout
-- refuse shortages (enforced in create_sale_order below).
alter table public.stores
  add column if not exists allow_negative_stock boolean not null default true;

-- ---------- 2) stock gets a home: inventory.stock_qty read model ----------
alter table public.inventory
  add column if not exists stock_qty integer not null default 0;

-- Backfill from the ledger (re-runnable: recomputes rather than accumulates).
update public.inventory i
   set stock_qty = coalesce(m.total, 0)
  from (
        select product_id, sum(qty)::integer as total
          from public.stock_movements
         group by product_id
       ) m
 where m.product_id = i.id
   and i.stock_qty is distinct from coalesce(m.total, 0);

-- The trigger keeps the cache glued to the ledger for EVERY writer (the
-- checkout RPC, the POS +/- buttons, adjustments, the legacy client path).
-- SECURITY INVOKER on purpose: the movement insert already passed RLS as the
-- caller, so the same tenant + license rules cover this update too.
create or replace function public.sync_stock_qty() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.product_id is distinct from old.product_id then
    update public.inventory set stock_qty = stock_qty - old.qty where id = old.product_id;
    update public.inventory set stock_qty = stock_qty + new.qty where id = new.product_id;
    return new;
  end if;

  if tg_op = 'INSERT' then
    update public.inventory set stock_qty = stock_qty + new.qty where id = new.product_id;
  elsif tg_op = 'UPDATE' then
    update public.inventory set stock_qty = stock_qty + (new.qty - old.qty) where id = new.product_id;
  else
    update public.inventory set stock_qty = stock_qty - old.qty where id = old.product_id;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists stock_qty_sync on public.stock_movements;
create trigger stock_qty_sync
  after insert or update or delete on public.stock_movements
  for each row execute function public.sync_stock_qty();

-- available_stock(): what the app asks instead of downloading the ledger.
create or replace function public.available_stock(p_product uuid) returns integer
language sql stable security invoker set search_path = public as $$
  select coalesce((select i.stock_qty from public.inventory i where i.id = p_product), 0);
$$;

-- The old client summed every movement row per product; make that lookup
-- index-backed while the fallback path still exists.
create index if not exists idx_stock_mv_product
  on public.stock_movements (product_id);

-- ---------- 3) atomic invoice counter ----------
create table if not exists public.invoice_counter (
  store_id uuid      not null references public.stores(id) on delete cascade,
  prefix   text      not null default '',
  next_val bigint    not null,
  primary key (store_id, prefix)
);

-- Reachable only through next_invoice_no() + the checkout RPC: RLS keeps
-- clients store-scoped (same rules as sales), nothing free-forms the sequence.
alter table public.invoice_counter enable row level security;
alter table public.invoice_counter force row level security;
drop policy if exists lensy_tenant_read   on public.invoice_counter;
drop policy if exists lensy_tenant_insert on public.invoice_counter;
drop policy if exists lensy_tenant_update on public.invoice_counter;
drop policy if exists lensy_tenant_delete on public.invoice_counter;
create policy lensy_tenant_read on public.invoice_counter for select to authenticated
  using (public.is_platform_admin()
         or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id))));
create policy lensy_tenant_insert on public.invoice_counter for insert to authenticated
  with check (public.is_platform_admin()
              or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id))));
create policy lensy_tenant_update on public.invoice_counter for update to authenticated
  using (public.is_platform_admin()
         or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id))))
  with check (public.is_platform_admin()
              or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id))));
create policy lensy_tenant_delete on public.invoice_counter for delete to authenticated
  using (public.is_platform_admin()
         or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id))));

-- Next zero-padded invoice for the caller's store. SECURITY INVOKER: RLS
-- scopes every read/write; the counter row's lock serialises two registers so
-- they can never draw the same number. The counter is lazily seeded from the
-- store's highest EXISTING numeric invoice (legacy PRESC-… rows are ignored),
-- so it drops into any database without a backfill step.
create or replace function public.next_invoice_no() returns text
language plpgsql security invoker set search_path = public as $$
declare
  v_store uuid;
  v_next  bigint;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  insert into public.invoice_counter (store_id, prefix, next_val)
  select v_store, '',
         coalesce(max(case when invoice_no ~ '^[0-9]+$' then invoice_no::bigint end), 0) + 1
    from public.sales
   where store_id = v_store
  on conflict (store_id, prefix) do nothing;

  update public.invoice_counter
     set next_val = next_val + 1
   where store_id = v_store and prefix = ''
  returning next_val - 1 into v_next;

  -- 6 digits zero-padded, exactly like the old format; never TRUNCATE above
  -- 999999 (lpad() would silently fold 1000000 back to 000000).
  return case when v_next < 1000000 then lpad(v_next::text, 6, '0') else v_next::text end;
end $$;

-- ---------- 4) idempotency ----------
alter table public.sales
  add column if not exists idempotency_key uuid;
create unique index if not exists sales_store_idempotency_key
  on public.sales (store_id, idempotency_key);

-- ---------- 5) constraints: illegal states become unrepresentable ----------
-- Added NOT VALID first so a database with legacy oddities still accepts this
-- paste, then validated inside a guard that WARNs (with the constraint named)
-- instead of aborting when old rows disagree.
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('sale_items', 'sale_items_qty_positive',      'check (qty > 0)'),
      ('sale_items', 'sale_items_unit_price_nonneg', 'check (unit_price >= 0)'),
      ('sale_items', 'sale_items_total_matches',     'check (total_price = qty * unit_price)'),
      ('sales',      'sales_amount_paid_nonneg',     'check (amount_paid >= 0)'),
      ('sales',      'sales_discount_nonneg',        'check (discount >= 0)'),
      ('sales',      'sales_discount_le_total',      'check (discount <= total_amount)'),
      ('sales',      'sales_net_matches',            'check (net_amount = total_amount - discount)')
    ) as t(tbl, cname, expr)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = rec.cname
         and conrelid = ('public.' || rec.tbl)::regclass
    ) then
      execute format('alter table public.%I add constraint %I %s not valid',
                     rec.tbl, rec.cname, rec.expr);
    end if;

    if exists (
      select 1 from pg_constraint
       where conname = rec.cname
         and conrelid = ('public.' || rec.tbl)::regclass
         and not convalidated
    ) then
      begin
        execute format('alter table public.%I validate constraint %I',
                       rec.tbl, rec.cname);
      exception when check_violation then
        raise warning 'lensy: constraint public.% is NOT valid - existing rows violate it; run the 012 remediation query from its header', rec.cname;
      end;
    end if;
  end loop;
end $$;

-- ---------- 6) atomic "add product + opening stock" ----------
-- The app used to do two separate writes (product, then movement) - a failure
-- between them left a product with phantom stock. Same shape the types file
-- already documented, now real.
create or replace function public.add_inventory_item(
  p_product       jsonb,
  p_initial_stock integer default 0
) returns public.inventory
language plpgsql security invoker set search_path = public as $$
declare
  v_inv public.inventory;
begin
  insert into public.inventory
    (name, sku, barcode, category, brand, frame_type, frame_color, cost_price, sale_price)
  select r.name, r.sku, r.barcode, r.category, r.brand, r.frame_type, r.frame_color,
         r.cost_price, r.sale_price
    from jsonb_populate_record(null::public.inventory, p_product) r
  returning * into v_inv;

  if coalesce(p_initial_stock, 0) > 0 then
    insert into public.stock_movements (product_id, store_id, qty, type, note)
    values (v_inv.id, v_inv.store_id, p_initial_stock, 'initial', 'Initial stock');
  end if;

  return v_inv;
end $$;

-- ---------- 7) create_sale_order: validate & recompute ----------
-- Drop the old overloads FIRST (same trick as 011): leaving the 3/4-arg
-- versions beside the new 5-param one would make PostgREST unable to resolve
-- calls that omit p_idempotency_key.
drop function if exists public.create_sale_order(jsonb, jsonb, jsonb);
drop function if exists public.create_sale_order(jsonb, jsonb, jsonb, jsonb);

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
  v_in        public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale      public.sales;
  v_store     uuid;
  v_inv       text;
  v_allow     boolean;
  v_net       numeric;
  v_total     numeric;
  v_discount  numeric;
  v_items     numeric := 0;
  v_paid_hdr  numeric;
  v_paid_led  numeric;
  v_prices    jsonb := '{}'::jsonb;
  v_line      record;
  v_cat       numeric;
  v_cat_name  text;
  v_stock     integer;
begin
  v_store := public.auth_store_id();
  if v_store is null then
    raise exception 'no store for the signed-in user';
  end if;

  -- 0) Idempotency: a replayed checkout returns the sale it already created
  --    (double-tap, retry after a lost response, offline replay in Phase 6).
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

  -- 1) Lock every product in the cart (sorted, so two registers never
  --    deadlock) and collect the catalog prices the DB will actually charge.
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

    if not v_allow and coalesce(v_stock, 0) < v_line.qty then
      raise exception 'insufficient stock: %', coalesce(v_cat_name, 'unknown product');
    end if;

    v_prices := v_prices || jsonb_build_object(v_line.product_id::text, coalesce(v_cat, 0));
  end loop;

  -- 2) Validate every line against the catalog (T1): a stale cart is refused
  --    instead of re-priced, and quantities must be positive.
  for v_line in
    select r.product_id, r.qty, r.unit_price
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
    v_items := v_items + v_line.qty * v_cat;
  end loop;

  -- 3) Recompute the header from the ONE money input that survives: the
  --    client's net. Below the catalog sum the gap becomes an explicit
  --    discount; above it (round-up) the declared total stands.
  v_net := coalesce(v_in.net_amount,
                    coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0));
  if v_net < -0.01 then
    raise exception 'negative net amount';
  end if;
  v_net := round(v_net, 2);

  if v_net <= v_items + 0.01 then
    v_total    := v_items;
    v_discount := round(greatest(0, v_items - v_net), 2);
    v_net      := v_total - v_discount;
  else
    v_total    := v_net;
    v_discount := 0;
  end if;

  -- 4) Money in can never exceed money out (header AND ledger).
  v_paid_hdr := coalesce(v_in.amount_paid, 0);
  if v_paid_hdr < -0.01 then
    raise exception 'negative payment amount';
  end if;
  select coalesce(sum(r.amount), 0) into v_paid_led
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;
  if v_paid_hdr > v_net + 0.01 or v_paid_led > v_net + 0.01 then
    raise exception 'payment exceeds net amount';
  end if;

  -- 5) Invoice number: the wizard's reservation when it is still free,
  --    otherwise the next number from the atomic counter.
  v_inv := nullif(trim(v_in.invoice_no), '');
  if v_inv is not null and exists (select 1 from public.sales where invoice_no = v_inv) then
    v_inv := null;
  end if;
  if v_inv is null then
    v_inv := public.next_invoice_no();
  end if;

  -- 6) Header first: this also CLAIMS the idempotency key. A concurrent
  --    replay blocks on the unique index, then finds the winner's row here;
  --    an invoice_no collision re-raises for the client's retry loop.
  begin
    insert into public.sales
      (invoice_no, store_id, idempotency_key, customer_id, user_id,
       total_amount, discount, net_amount, amount_paid, payment_method,
       order_date, delivery_date, doctor_name, lab_status,
       rx_image_path, frame_image_path)
    values
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, v_in.user_id,
       v_total, v_discount, v_net, v_paid_hdr, coalesce(v_in.payment_method, 'Cash'),
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

  -- 7) Line items, written at CATALOG prices (client totals are ignored).
  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name)
  select v_sale.id, v_store, r.product_id, r.qty,
         (v_prices ->> r.product_id::text)::numeric,
         r.qty * (v_prices ->> r.product_id::text)::numeric,
         r.name
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- one negative stock movement per line (the sync trigger above updates the
  -- stock_qty read model in the same transaction)
  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_store, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), now()
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- examinations
  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select v_sale.id, v_store, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_in.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  -- payment lines; the sale_payments_sync trigger (011) recomputes
  -- sales.amount_paid from these rows, so header and ledger cannot disagree.
  insert into public.sale_payments
    (sale_id, amount, method, note, paid_at, store_id, recorded_by)
  select v_sale.id,
         r.amount,
         coalesce(lower(trim(r.method)), 'cash'),
         r.note,
         coalesce(r.paid_at, current_date),
         v_store,
         coalesce(r.recorded_by, auth.uid())
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount > 0;

  return v_sale;
end $$;

-- ---------- grants ----------
grant execute on function public.available_stock(uuid) to authenticated;
grant execute on function public.next_invoice_no() to authenticated;
grant execute on function public.add_inventory_item(jsonb, integer) to authenticated;
grant execute on function public.create_sale_order(jsonb, jsonb, jsonb, jsonb, uuid)
  to authenticated;
