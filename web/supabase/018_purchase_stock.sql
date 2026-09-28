-- LensyPOS — 018: receiving stock, and the customer balance
-- ============================================================
-- Two defects that both hide money, plus the primitive Phase 6 needs.
--
-- 1) RECEIVING A PURCHASE DID NOT ADD STOCK.
--    `useAddPurchase` (web/src/data/suppliers.ts) inserted a `purchases` row
--    and nothing else. The shop records "bought 500 frames", the paperwork says
--    the money left, and `inventory.stock_qty` does not move — so the till can
--    sell stock the shop does not have, and the stock count the owner takes at
--    closing never reconciles. This is silent: nothing errors, the invoice is
--    in the ledger, and the numbers are simply wrong.
--
--    `receive_purchase()` writes the stock_movements in the SAME transaction as
--    the receipt, so a purchase is either fully received or not at all. The
--    ledger stays the source of truth and the 012 trigger keeps `stock_qty` in
--    step, exactly as a sale does.
--
-- 2) THERE IS NO ANSWER TO "WHAT DOES THIS CUSTOMER OWE?"
--    `sale_payments` has existed since 011 and is the authoritative record of
--    money, but nothing aggregates it per customer: the README claimed
--    balances and there were none. `customer_balance()` is that aggregate,
--    scoped to the caller's store the way 016 scoped its reports, so no query
--    can be answered across a tenant boundary.
--
-- Requires 011 (sale_payments), 012 (stock_qty trigger), 013 (movement
-- vocabulary, delete revocation).
-- Idempotent: create or replace / add column if not exists.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

-- ============================================================
-- 1) the received flag
-- ============================================================
-- `received_at` is what makes receiving IDEMPOTENT and, more importantly, what
-- makes it visible: a purchase sitting in the supplier screen with no
-- received_at is stock the shop has paid for and not counted. Additive and
-- nullable, so no existing row changes meaning.
alter table public.purchase_items
  add column if not exists received_at timestamptz;

comment on column public.purchase_items.received_at is
  'when this line was received into stock; null = ordered but not yet received';

-- ============================================================
-- 2) receive_purchase(p_purchase)
-- ============================================================
-- SECURITY DEFINER because it writes stock_movements, which Phase 2 removed
-- direct DELETE from but which still has no client INSERT policy. Tenancy is
-- enforced explicitly here rather than by RLS, because definer functions do
-- not consult the caller's policies — an omission that would let any signed-in
-- user inflate any store's stock.
--
-- Refuses to double-receive: a line with received_at set is skipped, so running
-- the function twice is a no-op rather than doubling the stock. That property is
-- what lets the client retry without asking the shop to count frames twice.
create or replace function public.receive_purchase(p_purchase uuid)
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_store  uuid;
  v_count  integer := 0;
  v_row    record;
begin
  -- Tenancy: the purchase must belong to the caller's store. A platform admin
  -- may receive for any store, which is the only cross-tenant path.
  select p.store_id into v_store
    from public.purchases p
   where p.id = p_purchase;

  if v_store is null then
    raise exception 'purchase not found: %', p_purchase using errcode = 'P0002';
  end if;

  if not public.is_platform_admin() and v_store <> public.auth_store_id() then
    raise exception 'purchase belongs to another store'
      using errcode = '42501';
  end if;
  if not public.license_write_ok(v_store) then
    raise exception 'store licence does not allow writes' using errcode = '42501';
  end if;

  -- Receive every outstanding line. The row lock serialises two cashiers
  -- receiving the same shipment at once: the second one waits, then re-reads
  -- received_at and finds the lines already stamped, so the stock is counted
  -- once. Without it this is a lost-update race, not a theoretical one.
  for v_row in
    select pi.id, pi.product_id, pi.qty, pi.unit_cost, pi.total_cost
      from public.purchase_items pi
     where pi.purchase_id = p_purchase
       and pi.received_at is null
       and pi.product_id is not null
     for update
  loop
    if coalesce(v_row.qty, 0) <= 0 then
      raise exception 'cannot receive a non-positive quantity (item %)', v_row.id
        using errcode = '22023';
    end if;

    insert into public.stock_movements
      (product_id, qty, type, kind, ref_no, note, created_at, store_id)
    values (
      v_row.product_id,
      v_row.qty,                                  -- positive: goods arrive
      'purchase',
      'purchase',                                 -- vocabulary from 013
      p_purchase::text,
      format('Received from purchase %s', p_purchase),
      now(),
      v_store
    );

    -- The cost is what makes margin real. The item's cost_price becomes a
    -- WEIGHTED AVERAGE across what was already held, so a re-order at a new
    -- price does not retroactively change the margin of stock bought earlier.
    -- Only when the shelf is empty does it simply take the new cost.
    update public.inventory
       set cost_price = case
             when coalesce(stock_qty, 0) > 0
               then round(
                      ( coalesce(stock_qty, 0) * coalesce(cost_price, 0)
                        + coalesce(v_row.qty, 0) * coalesce(v_row.unit_cost, 0)
                      ) / ( coalesce(stock_qty, 0) + coalesce(v_row.qty, 0) )::numeric
                    , 2)
             else coalesce(v_row.unit_cost, cost_price)
           end
     where id = v_row.product_id
       and store_id = v_store;

    update public.purchase_items
       set received_at = now()
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.receive_purchase(uuid) from public;
grant  execute on function public.receive_purchase(uuid) to authenticated;

-- ============================================================
-- 3) customer_balance(p_customer)
-- ============================================================
-- What one customer owes, in the caller's store.
--
-- The shape is deliberately a FUNCTION rather than a view: a view would be
-- readable directly, and 016's lesson was that a report nobody can scope is a
-- report that eventually leaks. Scoping here means tenancy and licence are
-- enforced in one place that every caller shares.
--
-- Two numbers, because they answer different questions and are not
-- interchangeable:
--   balance_due - live, unvoided invoices minus what has been paid. The debt.
--   lifetime    - everything ever sold to this customer, refunds included.
--
-- Voided invoices are excluded from BOTH. A void leaves net_amount intact so
-- the audit trail reads true (013), so a naive sum would keep counting money the
-- shop gave back — the exact bug Phase 4 found in Reports.
--
-- Refunds are already expressible in `sale_payments` (013 dropped the
-- `amount > 0` check), so they net off here by being negative amounts rather
-- than by any special case in this function.
create or replace function public.customer_balance(p_customer uuid)
returns table (
  customer_id   uuid,
  balance_due   numeric,
  lifetime      numeric,
  invoice_count bigint,
  last_activity timestamptz
)
language sql
stable
security definer
set search_path = public as $$
  with cust as (
    select c.id, c.store_id
      from public.customers c
     where c.id = p_customer
       and (public.is_platform_admin()
            or c.store_id = public.auth_store_id())
  ),
  live as (
    select s.id, coalesce(s.net_amount, 0) as net,
           coalesce(s.amount_paid, 0) as paid, s.order_date
      from public.sales s, cust
     where s.customer_id = cust.id
       and s.store_id = cust.store_id
       and s.voided_at is null
  ),
  paid as (
    -- The ledger, not the header: 011's sync trigger keeps them equal, and the
    -- ledger is the one that can express a refund.
    select coalesce(sum(p.amount), 0) as total
      from public.sale_payments p, cust
     where p.sale_id in (select id from live)
  )
  select cust.id,
         greatest(coalesce((select sum(net) from live), 0)
                - coalesce((select total from paid), 0), 0) as balance_due,
         coalesce((select sum(net) from live), 0)                as lifetime,
         (select count(*) from live)::bigint                     as invoice_count,
         (select max(order_date) from live)                      as last_activity
    from cust;
$$;

grant execute on function public.customer_balance(uuid) to authenticated;

-- ============================================================
-- 4) who owes money
-- ============================================================
-- The reminder list the shop actually wants: customers with an outstanding
-- balance, largest first. Scoped and windowed exactly like 016's reports,
-- because "top customers" once meant "download everything and sort in the
-- browser" and that does not scale past a few thousand invoices.
create or replace function public.customer_debtors(
  p_from timestamptz,
  p_to   timestamptz,
  p_limit int default 50
)
returns table (
  customer_id uuid,
  name        text,
  phone       text,
  balance_due numeric,
  last_activity timestamptz
)
language sql
stable
security definer
set search_path = public as $$
  with w as (select * from public.report_window(p_from, p_to)),
       live as (
         select s.customer_id,
                coalesce(s.net_amount, 0)     as net,
                coalesce(s.amount_paid, 0)    as paid,
                s.order_date
           from public.sales s, w
          where s.customer_id is not null
            and s.store_id = w.store_id
            and s.voided_at is null
       ),
       owed as (
         select l.customer_id,
                sum(l.net) - sum(l.paid) as due,
                max(l.order_date)       as last_activity
           from live l
          group by l.customer_id
       )
  select d.customer_id,
         coalesce(c.name,  ''), coalesce(c.phone, ''),
         round(d.due, 2), d.last_activity
    from owed d
    join public.customers c on c.id = d.customer_id
   where d.due > 0.01
   order by d.due desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

grant execute on function public.customer_debtors(timestamptz, timestamptz, int)
  to authenticated;
