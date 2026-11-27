-- ===========================================================================
-- 030 - money fixes (offline-v2 Phase 0)
--
-- Six defects in the checkout/refund functions, fixed together because they
-- share the same functions and the same client release. None changes a table's
-- columns; every function keeps its signature and grants.
--
-- 1) RE-CHECKOUT REWROTE HISTORY (H1/H2). update_sale_order deleted every
--    sale_payments row of the invoice - refund rows written by refund_sale (028)
--    included - and every 'sale' stock movement, then re-inserted what the
--    client sent, all stamped now(). Day-1 Z totals stopped matching the shift
--    that was closed, refunds and their reasons vanished, and a client that
--    sent the display summary ('Cash + InstaPay') as a tender wrote phantom
--    income on a method that does not exist. It now APPENDS signed deltas: the
--    ledger and the stock movements are reconciled to the desired state and
--    nothing is ever deleted or re-dated. A re-checkout that would give money
--    back in total is refused with 'refund first': the cashier records the
--    refund from History (refund_sale), choosing the tender and the reason,
--    so the server never decides which tender the drawer paid out from. A
--    tender swap at the same total (cash -> card) appends a refund row on the
--    tender that went down and needs history.refund. Unknown
--    tenders are refused; a legacy collapsed method already in the ledger
--    ('cash + instapay', written by the 011 backfill or a pre-030 re-checkout)
--    may stay as it is or go down, but may not take NEW money, because z_report
--    never counts it as drawer cash. A client that opened the invoice before a
--    later payment/refund is told to reload: it may send what it believed was
--    paid (expected_amount_paid) and the per-tender sums it saw
--    (expected_tenders), both optional, so a refund on one tender plus a
--    collection on another at the same total is caught too. The
--    stock guard checks only units the re-checkout newly takes, so a shop with
--    allow_negative_stock = false can re-checkout an order that sold its last
--    unit.
--
-- 2) LINE DISCOUNTS WERE CHARGED BACK (H3). price_cart added every line
--    discount back onto the net when a line discount was present (2 x 500, 100
--    off a line, net 900 was stored as 1000 / 0 / 1000). The client's net is now
--    kept exactly; the header discount is the WHOLE discount (line + header).
--    Without line discounts the result is identical to 013.
--
-- 3) A PARTLY REFUNDED SALE COULD NOT BE VOIDED (H4). void_sale mirrored every
--    original payment row and ignored refund_sale's rows, so the ledger summed
--    below zero and sales_amount_paid_nonneg aborted the void. It now refunds
--    the NET left on each tender.
--
-- 4) A REPLAYED CHECKOUT AFTER A POLICY CHANGE FAILED (H8). The idempotency
--    lookup ran after the permission/licence/active checks, so a lost-response
--    replay after the cashier was deactivated or the licence lapsed reported
--    "failed" for a sale that exists. The lookup now runs first, scoped to the
--    caller's own store. A NEW key is still refused exactly as before.
--
-- 5) INVOICE NUMBERS ARE PER STORE. The counter (012) is per store but
--    sales_invoice_no_key was global, so a second store drew 000001 and could
--    not check out while another store held that number. Uniqueness is now
--    (store_id, invoice_no).
--
-- 6) THE CLIENT'S CLOCK IS BOUNDED. A checkout queued offline is replayed with
--    the time Finish was pressed, so it lands in the day the money was taken.
--    That time comes from the device clock, so create_sale_order now keeps a
--    client order_date / paid_at only inside [the store's latest closed shift's
--    to_at (and at most 2 days back), now()]. Outside it the time is moved to
--    the nearest bound: a slow clock or a late replay can no longer put money
--    into a shift whose expected cash is already frozen, and a fast clock
--    cannot date a sale in the future.
--
-- SHIP WITH THE CLIENT. The web client that sends line discounts on the first
-- checkout must not run against a database without (2), and the client is what
-- sends the ledger-true tenders (1). EXPECTED_SCHEMA_VERSION moves to 30 in the
-- same release so the banner flags a shop that has not run this. See
-- RELEASE_030.md.
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 029).
-- ===========================================================================
begin;

-- ============================================================
-- 1) invoice numbers are unique per store, like the counter
-- ============================================================
-- The new index is created BEFORE the global constraint goes, so there is no
-- moment without uniqueness. A database that already satisfies the global rule
-- trivially satisfies the per-store one.
create unique index if not exists sales_store_invoice_no_key
  on public.sales (store_id, invoice_no);
alter table public.sales drop constraint if exists sales_invoice_no_key;

-- ============================================================
-- 2) price_cart: the client's net survives line discounts
-- ============================================================
-- Steps 1-2 (lock, catalog check, line-discount validation) are 013's,
-- unchanged. Step 3 no longer adds line discounts back: the catalog gross is
-- the total and EVERY discount is the header discount.
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
  v_net := greatest(0, round(v_net, 2));

  if v_net <= v_items + 0.01 then
    -- the catalog gross is the total; EVERY discount (line + header) is the
    -- header discount, so the client's net survives exactly (012 T4 contract)
    v_total    := v_items;
    v_discount := least(v_items, round(greatest(0, v_items - v_net), 2));
    v_net      := v_total - v_discount;
  else
    v_total    := v_net;   -- negotiated price above catalog (012 T5), unchanged
    v_discount := 0;
  end if;

  return query select v_total, v_discount, v_net, v_prices, v_items;
end $$;

-- ============================================================
-- 2b) sale_event_time: the device clock, bounded
-- ============================================================
-- The time a checkout says it happened (order_date / paid_at), kept only when
-- it is plausible: never in the future (now()), never inside a shift this store
-- has already closed (its latest to_at; z_report windows are [from, to), so
-- to_at itself belongs to the NEXT shift), and never more than 2 days back (the
-- offline queue is discarded after 24 h, so an older time is a wrong clock, not
-- a late replay). Null means "no client time": now().
create or replace function public.sale_event_time(p_store uuid, p_at timestamptz)
returns timestamptz
language sql stable
set search_path = public as $$
  select least(now(),
               greatest(coalesce(p_at, now()),
                        now() - interval '2 days',
                        coalesce((select max(c.to_at) from public.shift_closes c
                                   where c.store_id = p_store), '-infinity'::timestamptz)))
$$;
revoke execute on function public.sale_event_time(uuid, timestamptz) from public, anon, authenticated;

-- ============================================================
-- 3) create_sale_order: a replay is answered before the gates
-- ============================================================
-- 029's body with these changes: an unknown tender is refused, client times
-- go through sale_event_time (2b) - for the sale, its payments and its stock
-- movements - the idempotency lookup runs FIRST, keyed on the
-- caller's own users.store_id (no is_active / role / licence check - returning
-- the existing row only acknowledges a sale that already happened, and the
-- random v4 key names exactly that one sale), and the reservation check looks
-- only at this store's invoices.
create or replace function public.create_sale_order(
  p_sale            jsonb,
  p_items           jsonb default '[]'::jsonb,
  p_exams           jsonb default '[]'::jsonb,
  p_payments        jsonb default '[]'::jsonb,
  p_idempotency_key uuid  default null
) returns public.sales
language plpgsql
security definer
set search_path = public as $$
declare
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_inv      text;
  v_allow    boolean;
  v_paid_hdr numeric;
  v_paid_led numeric;
  v_kind     text := 'sale';
  v_at       timestamptz;
  t          record;
begin
  -- Idempotency first (030): a replay of a checkout that already committed
  -- returns that sale even if the cashier, the role or the licence changed in
  -- between. Only a NEW key goes on to the checks below.
  if p_idempotency_key is not null then
    select s.* into v_sale
      from public.sales s
     where s.idempotency_key = p_idempotency_key
       and s.store_id = (select u.store_id from public.users u where u.id = auth.uid());
    if found then
      return v_sale;
    end if;
  end if;

  if (p_sale->>'customer_id') is not null and not exists(select 1 from public.customers where id=(p_sale->>'customer_id')::uuid and store_id=public.auth_store_id()) then raise exception 'Customer not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as i(product_id uuid) where i.product_id is not null and not exists(select 1 from public.inventory where id=i.product_id and store_id=public.auth_store_id())) then raise exception 'Product not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(amount numeric) where p.amount < 0) then raise exception 'Use the refund action to return money'; end if;
  -- A tender must be one the shop takes (030), as update_sale_order and
  -- collect_sale_payment already require: money taken on 'visa' or a display
  -- summary like 'Cash + InstaPay' is income no Z report counts as a drawer.
  -- A missing method is cash, as below.
  if exists (
    select 1 from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
     where r.amount is not null and r.amount <> 0
       and coalesce(lower(trim(r.method)), 'cash') not in ('cash', 'wallet', 'instapay', 'card')
  ) then
    raise exception 'Invalid payment method';
  end if;
  perform public.require_perm('pos.create');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
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

  -- The sale's time: the client's (a replayed offline checkout keeps the time
  -- Finish was pressed) only inside sale_event_time's bounds.
  v_at := public.sale_event_time(v_store, v_in.order_date);

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

  -- 022: the kind is decided from the cart, never believed (see 022/029).
  if v_in.kind = 'prescription'
     and t.total_amount = 0
     and not exists (
       select 1 from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
        where r.amount is not null and r.amount <> 0)
  then
    v_kind := 'prescription';
  end if;

  -- invoice number: the wizard's reservation when still free IN THIS STORE,
  -- else the (per-store) counter
  v_inv := nullif(trim(v_in.invoice_no), '');
  if v_inv is not null and exists (select 1 from public.sales where store_id = v_store and invoice_no = v_inv) then
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
      (v_inv, v_store, p_idempotency_key, v_in.customer_id, auth.uid(),
       t.total_amount, t.discount, t.net_amount, v_paid_hdr,
       coalesce(v_in.payment_method, 'Cash'),
       v_at, v_in.delivery_date, v_in.doctor_name,
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

  -- Dated with the sale (v_at), so a checkout replayed from the offline queue
  -- takes its stock off the shelf when it was sold, not when it synced.
  insert into public.stock_movements
    (product_id, store_id, qty, type, ref_no, note, created_at)
  select r.product_id, v_store, -r.qty, 'sale', v_sale.invoice_no,
         'POS Sale: ' || coalesce(v_sale.invoice_no, ''), v_at
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
         -- a client time is bounded like the sale's; none means now()
         public.sale_event_time(v_store, r.paid_at),
         v_store,
         auth.uid()
    from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
   where r.amount is not null and r.amount <> 0;

  return v_sale;
end $$;

-- ============================================================
-- 4) update_sale_order: reconcile by appending, never delete
-- ============================================================
-- p_payments is the DESIRED per-method tender state (what the client already
-- sends, and what 013 G5e expects). The ledger is brought there by appending
-- signed per-method deltas; the stock by appending per-product deltas. Items and
-- examinations are still replaced, and the header update is 029's.
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
  v_in       public.sales := jsonb_populate_record(null::public.sales, p_sale);
  v_sale     public.sales;
  v_store    uuid;
  v_allow    boolean;
  v_paid     numeric;
  v_ledger   numeric;
  v_deltas   jsonb;
  v_short    text;
  t          record;
begin
  if (p_sale->>'customer_id') is not null and not exists(select 1 from public.customers where id=(p_sale->>'customer_id')::uuid and store_id=public.auth_store_id()) then raise exception 'Customer not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as i(product_id uuid) where i.product_id is not null and not exists(select 1 from public.inventory where id=i.product_id and store_id=public.auth_store_id())) then raise exception 'Product not found in this store'; end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(amount numeric) where p.amount < 0) then raise exception 'Use the refund action to return money'; end if;
  if not (public.resolve_can('pos.edit') or public.resolve_can('history.edit')) then raise exception 'insufficient permission: history.edit or pos.edit' using errcode='42501'; end if;
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
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
  if (case when jsonb_array_length(p_exams)>0 then coalesce(v_in.lab_status,'Not Started') else null end)
    is distinct from v_sale.lab_status then perform public.require_perm('lab.edit'); end if;
  if not public.is_store_admin() and
    ((v_sale.rx_image_path is not null and v_in.rx_image_path is distinct from v_sale.rx_image_path) or
     (v_sale.frame_image_path is not null and v_in.frame_image_path is distinct from v_sale.frame_image_path)) then
    raise exception 'Replace requires admin' using errcode='42501';
  end if;

  -- Stale client (030, optional key): the client says what it believed was
  -- paid. If a payment or refund landed since it opened the invoice, its tender
  -- list is out of date and reconciling to it would undo that money.
  -- jsonb_populate_record ignores the key, so an older client is unaffected.
  if nullif(p_sale->>'expected_amount_paid', '') is not null
     and abs((p_sale->>'expected_amount_paid')::numeric - coalesce(v_sale.amount_paid, 0)) > 0.005 then
    raise exception 'invoice changed since it was opened; reload it';
  end if;

  -- ...and, per tender (030, optional key): the same total can hide a change -
  -- a History refund of 100 cash plus a collection of 100 card - that
  -- reconciling to the stale tender list would silently reverse. The client
  -- sends the per-method sums it built from the ledger it saw
  -- ([{"method","amount"}]); both sides are grouped the same way (method as
  -- lower(trim()), amounts summed, a method that nets to 0 dropped).
  if jsonb_typeof(p_sale->'expected_tenders') = 'array' and exists (
    with seen as (
      select coalesce(lower(trim(e->>'method')), '') as m, sum((e->>'amount')::numeric) as a
        from jsonb_array_elements(p_sale->'expected_tenders') e
       group by 1
      having abs(coalesce(sum((e->>'amount')::numeric), 0)) > 0.005
    ), cur as (
      select coalesce(lower(trim(sp.method)), '') as m, sum(sp.amount) as a
        from public.sale_payments sp
       where sp.sale_id = p_sale_id
       group by 1
      having abs(sum(sp.amount)) > 0.005
    )
    select 1
      from seen full join cur on cur.m = seen.m
     where abs(coalesce(seen.a, 0) - coalesce(cur.a, 0)) > 0.005
  ) then
    raise exception 'invoice changed since it was opened; reload it';
  end if;

  -- A tender must be a real method, or one this invoice's ledger already uses
  -- (a legacy backfilled row). The display summary 'Cash + InstaPay' is neither.
  -- A legacy method passes here only to be KEPT or reduced; the delta check
  -- below refuses it any new money.
  if exists (
    select 1
      from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
     where r.amount is not null and r.amount <> 0
       and coalesce(lower(trim(r.method)), 'cash') not in ('cash', 'wallet', 'instapay', 'card')
       and not exists (select 1 from public.sale_payments sp
                        where sp.sale_id = p_sale_id
                          and lower(trim(sp.method)) = coalesce(lower(trim(r.method)), 'cash'))
  ) then
    raise exception 'Invalid payment method';
  end if;

  select s.allow_negative_stock into v_allow
    from public.stores s
   where s.id = v_store;
  if v_allow is null then
    v_allow := true;
  end if;

  -- Priced (and locked) with the absolute stock check OFF: the units this sale
  -- already took are off the shelf, so comparing the full cart against the
  -- shelf refused an unchanged re-checkout of a last unit.
  select * into t
    from public.price_cart(p_items, coalesce(v_in.net_amount,
                                             coalesce(v_in.total_amount, 0) - coalesce(v_in.discount, 0)),
                           true);

  -- ...so the guard checks only what this re-checkout newly takes.
  if not v_allow then
    select i.name into v_short
      from (select r.product_id, sum(r.qty) as q
              from jsonb_populate_recordset(null::public.sale_items, p_items) r
             where r.product_id is not null
             group by r.product_id) n
      left join (select sm.product_id, -sum(sm.qty) as q
                   from public.stock_movements sm
                  where sm.type = 'sale' and sm.ref_no = v_sale.invoice_no and sm.store_id = v_sale.store_id
                  group by sm.product_id) o on o.product_id = n.product_id
      join public.inventory i on i.id = n.product_id
     where n.q - coalesce(o.q, 0) > 0
       and coalesce(i.stock_qty, 0) < n.q - coalesce(o.q, 0)
     limit 1;
    if found then
      raise exception 'insufficient stock: %', coalesce(v_short, 'unknown product');
    end if;
  end if;

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

  -- Refund first: less money in total than the ledger holds means money goes
  -- back to the customer. Which tender it left the drawer on is a fact only the
  -- cashier knows, so it is recorded with refund_sale (tender + reason, from
  -- History), never guessed here from whichever lines the client trimmed. The
  -- reopened invoice then re-checks out with the ledger it now has.
  select coalesce(sum(sp.amount), 0) into v_ledger
    from public.sale_payments sp
   where sp.sale_id = p_sale_id;
  if v_paid < v_ledger - 0.005 then
    raise exception 'refund first: % of the % paid would go back; record the refund from History, then reopen the invoice',
      round(v_ledger - v_paid, 2), round(v_ledger, 2);
  end if;

  -- Per-method deltas from the ledger as it is to the tenders desired.
  with cur as (
    select lower(trim(sp.method)) as m, sum(sp.amount) as a
      from public.sale_payments sp
     where sp.sale_id = p_sale_id
     group by 1
  ), tgt as (
    select coalesce(lower(trim(r.method)), 'cash') as m, sum(r.amount) as a
      from jsonb_populate_recordset(null::public.sale_payments, p_payments) r
     where r.amount is not null and r.amount <> 0
     group by 1
  ), d as (
    select coalesce(tgt.m, cur.m) as m,
           round(coalesce(tgt.a, 0) - coalesce(cur.a, 0), 2) as da
      from cur full join tgt on tgt.m = cur.m
  )
  select coalesce(jsonb_agg(jsonb_build_object('m', d.m, 'da', d.da) order by d.da desc, d.m), '[]'::jsonb)
    into v_deltas
    from d
   where d.da <> 0;

  -- New money only on a real tender. A legacy collapsed method ('cash +
  -- instapay', 'visa') is not a drawer z_report counts, so money taken on it
  -- would be income no shift ever cashes up. It may stay or go down (a refund
  -- row, history.refund below), never up.
  if exists (select 1 from jsonb_to_recordset(v_deltas) as x(m text, da numeric)
              where x.da > 0 and x.m not in ('cash', 'wallet', 'instapay', 'card')) then
    raise exception 'Invalid payment method';
  end if;

  -- With the total unchanged or higher, a tender can still go down (cash ->
  -- card): the cashier chose that line by line, and it is a refund on that
  -- tender.
  if exists (select 1 from jsonb_to_recordset(v_deltas) as x(m text, da numeric) where x.da < 0) then
    perform public.require_perm('history.refund');
  end if;

  -- Items and examinations are replaced; the ledger and stock are NOT.
  delete from public.sale_items         where sale_id = p_sale_id;
  delete from public.order_examinations where sale_id = p_sale_id;

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
                          when jsonb_array_length(p_exams) > 0 then coalesce(v_in.lab_status, 'Not Started')
                          else null
                        end,
         rx_image_path  = v_in.rx_image_path,
         frame_image_path = v_in.frame_image_path
   where id = p_sale_id
  returning * into v_sale;

  insert into public.sale_items
    (sale_id, store_id, product_id, qty, unit_price, total_price, name,
     discount, discount_reason)
  select p_sale_id, v_sale.store_id, r.product_id, r.qty,
         (t.prices ->> r.product_id::text)::numeric,
         r.qty * (t.prices ->> r.product_id::text)::numeric,
         r.name, coalesce(r.discount, 0), r.discount_reason
    from jsonb_populate_recordset(null::public.sale_items, p_items) r;

  -- Stock: one movement per product whose quantity changed, for the change
  -- only. The original movements keep their dates.
  with o as (
    select sm.product_id, -sum(sm.qty) as q
      from public.stock_movements sm
     where sm.type = 'sale' and sm.ref_no = v_sale.invoice_no and sm.store_id = v_sale.store_id
     group by sm.product_id
  ), n as (
    select r.product_id, sum(r.qty) as q
      from jsonb_populate_recordset(null::public.sale_items, p_items) r
     where r.product_id is not null
     group by r.product_id
  )
  insert into public.stock_movements (product_id, store_id, qty, type, ref_no, note, created_at)
  select coalesce(n.product_id, o.product_id), v_sale.store_id,
         -(coalesce(n.q, 0) - coalesce(o.q, 0)), 'sale', v_sale.invoice_no,
         'POS Re-checkout: ' || coalesce(v_sale.invoice_no, ''), now()
    from o full join n on n.product_id = o.product_id
   where coalesce(n.q, 0) <> coalesce(o.q, 0);

  insert into public.order_examinations
    (sale_id, store_id, exam_type, sphere_od, cylinder_od, axis_od,
     sphere_os, cylinder_os, axis_os, ipd, lens_info, frame_info,
     frame_color, frame_status, doctor_name, image_path)
  select p_sale_id, v_sale.store_id, r.exam_type, r.sphere_od, r.cylinder_od, r.axis_od,
         r.sphere_os, r.cylinder_os, r.axis_os, r.ipd, r.lens_info, r.frame_info,
         r.frame_color, r.frame_status,
         coalesce(r.doctor_name, v_sale.doctor_name), r.image_path
    from jsonb_populate_recordset(null::public.order_examinations, p_exams) r;

  -- Ledger: append the deltas. Money in is a 'payment', money back a 'refund'
  -- with a reason; earlier rows keep their amount, date and recorder.
  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id, x.da, x.m,
         case when x.da > 0 then 'payment' else 'refund' end,
         case when x.da < 0 then 'Re-checkout refund ' || coalesce(v_sale.invoice_no, '') end,
         now(), v_sale.store_id, auth.uid()
    from jsonb_to_recordset(v_deltas) as x(m text, da numeric);

  perform set_config('lensy.money_write', '', true);

  -- the ledger's own sync trigger has already recomputed amount_paid; re-read
  -- so the caller gets the authoritative header back.
  select * into v_sale from public.sales where id = p_sale_id;
  return v_sale;
end $$;

-- ============================================================
-- 5) void_sale: refund the NET left on each tender
-- ============================================================
-- 014's body, unchanged except the refund insert. Grouped by the exact method
-- string, matching refund_sale's per-tender ceiling (028); HAVING > 0 skips a
-- tender already refunded in full (a zero row is refused by
-- sale_payments_amount_nonzero). The ledger therefore ends at exactly 0.
create or replace function public.void_sale(
  p_sale_id uuid,
  p_reason  text,
  p_restock boolean default true
) returns public.sales
language plpgsql security definer set search_path = public as $$
declare
  v_sale  public.sales;
  v_store uuid;
begin
  perform public.require_perm('history.void');
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

  -- one refund per tender for what is STILL held on it, so the per-method
  -- cash-up stays truthful and a prior partial refund is not paid twice
  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id, -net.amt, net.method, 'refund',
         'Void ' || coalesce(v_sale.invoice_no, ''),
         now(), v_sale.store_id, auth.uid()
    from (select sp.method, sum(sp.amount) as amt
            from public.sale_payments sp
           where sp.sale_id = p_sale_id
           group by sp.method
          having sum(sp.amount) > 0) net
   order by net.method;

  update public.sales
     set voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end $$;

-- ============================================================
-- 6) grants (same as 013/029; re-stated so a re-run cannot lose them)
-- ============================================================
grant execute on function public.price_cart(jsonb, numeric, boolean) to authenticated;
revoke execute on function public.create_sale_order(jsonb,jsonb,jsonb,jsonb,uuid),
  public.update_sale_order(uuid,jsonb,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.create_sale_order(jsonb,jsonb,jsonb,jsonb,uuid),
  public.update_sale_order(uuid,jsonb,jsonb,jsonb,jsonb),
  public.void_sale(uuid,text,boolean) to authenticated;

-- ============================================================
-- 7) stamp THIS migration (020 makes an unstamped file a red build)
-- ============================================================
select public.record_schema_version(30, 'money fixes: re-checkout appends ledger/stock deltas (refund first, legacy tenders cannot take new money, per-tender stale check), price_cart keeps the net with line discounts, void after refund, idempotent replay first, per-store invoice numbers, bounded client time for sale/payments/stock, known tenders only');
commit;
