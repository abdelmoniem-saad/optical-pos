-- ===========================================================================
-- 032 - the actor core: permission checks for a named store, a store-scoped
--       Z report, actor columns that point at staff, and the weighted cost
--       (offline-v2 Phase 1, docs/offline-v2/design.md section 4.2)
--
-- !! APPLY RULE - READ BEFORE PASTING !!
--    Paste 032 only when the 031 web client (Phase 0b, PR #4) has been
--    deployed for AT LEAST 7 DAYS and EVERY shop device has been reloaded
--    since. Change (7) drops the global settings_key_key. A tab still running
--    a pre-031 build upserts a setting with ON CONFLICT (key); once that
--    constraint is gone the upsert fails ("there is no unique or exclusion
--    constraint matching the ON CONFLICT specification") and the shop cannot
--    save a setting until the tab reloads. The 031 client upserts on
--    (store_id, key), which 031 added and which stays.
--
-- 1) C1 - resolve_can AND is_store_admin COULD ANSWER FOR ANOTHER STORE.
--    resolve_can(code, user) (029) answered for any user id a caller passed:
--    a cashier of store A could ask what a person of store B may do, or
--    whether they are an owner (is_store_admin(user)). Both keep their ONE
--    definition, signature and grant (014:526, 029:200-204) and gain a
--    cross-store guard: a caller who is not a platform admin, asking about
--    somebody else, gets false unless that person is in the caller's own
--    store. Asking about yourself, and a platform admin asking about anyone,
--    are unchanged. Note the guard also answers false to a caller with no
--    signed-in user (no JWT) asking about a store user: nothing in the app or
--    in create-user does that (create-user asks about the CALLER).
--
--    The rule itself moves into two internal functions that take the store
--    explicitly, for the register ingest (033/034), which acts for a PC's
--    staff with no JWT of theirs:
--      _resolve_can_for(code, actor, store)  and  _is_store_admin_for(actor, store)
--    STABLE, SECURITY DEFINER, search_path pinned, NOT executable by any
--    client role. They have no platform-admin branch and require the actor to
--    be an ACTIVE user OF THAT STORE whose role belongs to that store; the
--    View-prerequisite recursion calls _resolve_can_for, so it stays in the
--    named store. resolve_can is now "supported code, platform self, guard,
--    then _resolve_can_for(code, user, user's own store)" and is_store_admin
--    likewise, so the online answer and the register answer cannot drift
--    (the 032 gate asserts parity for every fixture user and every code).
--
-- 2) tender_key(m): the one normalisation of a tender name, lower(btrim(m))
--    with blank or NULL meaning cash. IMMUTABLE. The register client has its
--    twin (tenderKey in tender.ts); both trim SPACES only - a tab or a
--    non-breaking space is kept - and the 032 gate pins the shared table.
--    Nothing existing is switched onto it here: every current writer and
--    report keeps its own spelling, so no behaviour changes.
--
-- 3) C2 - THE Z REPORT FOR A NAMED STORE. z_report (023) reads the store from
--    the caller's JWT. Its body moves verbatim into _z_report(store, from, to)
--    (internal, not executable by clients) and z_report becomes
--      select z.* from report_window(p_from, p_to) w,
--                      lateral _z_report(w.store_id, w.from_at, w.to_at) z
--    Same signature, grant and figures; close_shift is untouched and still
--    goes through z_report. (report_window's UTC-date rounding of p_to,
--    016:199-208, is correct only east of UTC; Cairo is fine.)
--
-- 4) M1 - ACTOR COLUMNS POINT AT STAFF, and sale_payments.store_id IS NOT
--    NULL. Both run inside one internal function, _repoint_actor_keys()
--    (not executable by any client role; idempotent, so an operator re-runs
--    it after fixing orphans), which the paste calls once. In this order:
--
--    a) sale_payments.store_id. Every writer passes it, but the column
--       allowed NULL (011:53), and a NULL-store row is money no report or Z
--       ever counts. Any such row is backfilled from its sale (always
--       possible: sale_id is NOT NULL and cascades, sales.store_id is NOT
--       NULL), then the column is made NOT NULL. This runs FIRST, while only
--       the old auth.users keys exist, and with sale_payments_sync switched
--       off for that one UPDATE (store_id does not change any sale's sum, so
--       the recompute is a no-op): the backfill touches the ledger rows only,
--       never a sales row. Otherwise each backfilled row re-updated its sale,
--       and from a sale's second update in this transaction Postgres re-runs
--       every key and CHECK on it - a voided_by that is not staff (against
--       the new key) or an old row failing a NOT VALID check would have
--       aborted the whole paste.
--    b) sale_payments.recorded_by (011:52), sales.voided_by (013:85) and
--       shift_closes.closed_by (023:62) referenced auth.users, so any sign-in
--       id was accepted. They now reference public.users(id) ON DELETE SET
--       NULL. The old foreign key is found by its column (its name was
--       generated), the new one is added NOT VALID, then validated inside a
--       guard that WARNS, naming the orphan query, instead of aborting the
--       paste (012's pattern). New rows are checked either way.
--    recorded_by keeps its default auth.uid(): under the register's JWT an
--    actor the writer forgot to pass fails the key loudly instead of being
--    attributed to the PC's account. A payment taken by a sign-in that is not
--    staff (a platform admin's own account) is refused from now on (23503).
--    After a warning, an orphaned row is still checked again whenever it is
--    next UPDATEd (a void, a payment on that sale): fix orphans soon.
--
-- 5) The paste runs _repoint_actor_keys() once. Before pasting, check for
--    orphans (they make 4b warn, not fail) and NULL-store ledger rows (4a
--    backfills them):
--      select sale_id, count(*) from public.sale_payments
--       where store_id is null group by 1;
--
-- 6) WEIGHTED COST WAS AVERAGED AFTER THE STOCK WAS ADDED. receive_purchase
--    (029:653-660) computed the new cost_price after the stock_qty_sync
--    trigger had already added the received quantity, so the received units
--    were weighted twice: 10 @ 4.00 then 10 @ 6.00 stored 4.67 instead of
--    5.00, in every store. The quantity held BEFORE the delivery is now
--    stock_qty - received qty; when it is not positive (empty or negative
--    shelf) the cost simply becomes the delivery's unit cost, as before.
--    tests/018_purchase_stock_test.sql G-P4b, which had been changed from 5
--    to 4.67 to match the defect, is corrected back to 5.00. Costs already
--    stored are not recomputed (the history to do so is not reliable).
--
-- 7) settings_key_key IS DROPPED (see the apply rule above). 031 added the
--    per-store unique (store_id, key) and the 031 client upserts on it; the
--    global key made two stores unable to hold the same setting name.
--    (tests/031_per_store_unique_test.sql ST1 pinned that the key stayed; the
--    gates run after every migration, so it now pins that it is gone.)
--
-- Idempotent: safe to paste more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 031,
-- and only under the apply rule above). EXPECTED_SCHEMA_VERSION is not bumped
-- for 032 alone; it moves to 33 with 033.
-- ===========================================================================
begin;

-- ============================================================
-- 1) C1: the permission rule for a named store, and the guarded wrappers
-- ============================================================
-- Owner/admin of p_store: an ACTIVE user of p_store whose role belongs to
-- p_store and is named admin/owner. 029:44-50 minus the platform branch.
create or replace function public._is_store_admin_for(p_actor uuid, p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.users u
      join public.roles r on r.id = u.role_id and r.store_id = u.store_id
     where u.id = p_actor and u.store_id = p_store and u.is_active is true
       and lower(trim(r.name)) in ('admin','owner')
  )
$$;

-- 029:52-71's rule, pinned to p_store and without the platform branch: the
-- actor must be an active user OF p_store with a role of p_store; admins may
-- do everything supported; otherwise the personal Allow/Deny wins over the
-- role grant, and an action needs its page's View (checked in the same store).
create or replace function public._resolve_can_for(p_code text, p_actor uuid, p_store uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_code text := replace(p_code, 'purchases.', 'suppliers.'); v_role uuid; v_view text; v_allowed boolean;
begin
  if not (v_code = any(public.supported_permissions())) then return false; end if;
  select u.role_id into v_role from public.users u
    join public.roles r on r.id = u.role_id and r.store_id = u.store_id
    where u.id = p_actor and u.store_id = p_store and u.is_active is true;
  if v_role is null then return false; end if;
  if public._is_store_admin_for(p_actor, p_store) then return true; end if;
  select coalesce(
    (select up.allow from public.user_permissions up join public.permissions p on p.id=up.permission_id where up.user_id=p_actor and p.code=v_code),
    exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where rp.role_id=v_role and p.code=v_code)
  ) into v_allowed;
  if not v_allowed then return false; end if;
  v_view := split_part(v_code,'.',1) || '.view';
  if v_code = v_view then return true; end if;
  return public._resolve_can_for(v_view, p_actor, p_store);
end $$;

revoke execute on function public._is_store_admin_for(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public._resolve_can_for(text, uuid, uuid) from public, anon, authenticated, service_role;

-- The one resolve_can (same signature, so 014's grant to authenticated and
-- 029's callers are untouched). Platform self first, exactly as 029; then
-- the cross-store guard; then the store rule in the user's own store.
create or replace function public.resolve_can(p_code text, p_user uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_code text := replace(p_code, 'purchases.', 'suppliers.');
begin
  if not (v_code = any(public.supported_permissions())) then return false; end if;
  if p_user = auth.uid() and public.is_platform_admin() then return true; end if;
  if p_user is distinct from auth.uid() and not public.is_platform_admin()
     and public.user_store(p_user) is distinct from public.auth_store_id() then
    return false;
  end if;
  return public._resolve_can_for(p_code, p_user, public.user_store(p_user));
end $$;

create or replace function public.is_store_admin(p_user uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_user = auth.uid() and public.is_platform_admin() then return true; end if;
  if p_user is distinct from auth.uid() and not public.is_platform_admin()
     and public.user_store(p_user) is distinct from public.auth_store_id() then
    return false;
  end if;
  return public._is_store_admin_for(p_user, public.user_store(p_user));
end $$;

-- Restated, not changed (create or replace keeps an ACL; this makes it
-- legible). is_store_admin: 029:198-204 (revoked from public/anon, granted to
-- authenticated). resolve_can: 014:526 only GRANTS to authenticated and
-- nothing ever revoked it, so PUBLIC (and anon) keep EXECUTE exactly as
-- before - it is deliberately NOT in the revoke. Under the guard, anon gets
-- false about any store user (no JWT, no store), as the 032 gate pins.
revoke execute on function public.is_store_admin(uuid) from public, anon;
grant execute on function public.resolve_can(text, uuid), public.is_store_admin(uuid) to authenticated;

-- ============================================================
-- 2) tender_key: the one spelling of a tender
-- ============================================================
create or replace function public.tender_key(m text) returns text
language sql immutable set search_path = public as $$
  select coalesce(nullif(lower(btrim(m)), ''), 'cash')
$$;

revoke execute on function public.tender_key(text) from public, anon;
grant execute on function public.tender_key(text) to authenticated;

-- ============================================================
-- 3) C2: _z_report for a named store; z_report wraps it
-- ============================================================
-- 023:112-169 verbatim, with the window CTE replaced by the parameters. The
-- bounds are already resolved (report_window's rounding happens in the
-- wrapper), and a NULL bound means open, exactly as before.
create or replace function public._z_report(p_store uuid, p_from timestamptz, p_to timestamptz)
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
  with in_window as (
    select p.method, p.amount
      from public.sale_payments p
     where p.store_id = p_store
       and (p_from is null or p.paid_at >= p_from)
       and (p_to   is null or p.paid_at <  p_to)
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
      from public.sales s
     where s.store_id = p_store
       and (p_from is null or s.order_date >= p_from)
       and (p_to   is null or s.order_date <  p_to)
  ),
  lab as (
    -- "Delivered" = the job REACHED Received inside the window (019's stamp).
    select count(*) as delivered
      from public.sales s
     where s.store_id = p_store
       and s.lab_status = 'Received'
       and (p_from is null or s.lab_status_changed_at >= p_from)
       and (p_to   is null or s.lab_status_changed_at <  p_to)
  )
  select pay.cash, tenders.by_tender, pay.total,
         cnt.orders, cnt.presc, cnt.voids, pay.refunds, lab.delivered
    from pay, tenders, cnt, lab
$$;

revoke execute on function public._z_report(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;

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
  select z.*
    from public.report_window(p_from, p_to) w,
         lateral public._z_report(w.store_id, w.from_at, w.to_at) z
$$;

grant execute on function public.z_report(timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 4) M1: sale_payments.store_id, then actor columns reference public.users
-- ============================================================
-- Internal and idempotent: the paste calls it once (section 5); after a
-- warning, fix the orphans and call it again to validate. Not SECURITY
-- DEFINER and not executable by any client role: only the owner (the SQL
-- editor's postgres) can run its DDL.
create or replace function public._repoint_actor_keys() returns void
language plpgsql set search_path = public as $$
declare
  rec record;
  v_att smallint;
  v_con text;
  v_sync "char";
begin
  -- a) store_id FIRST, before any new key exists (see the header, 4a). The
  --    sync trigger is switched off for this one UPDATE so no sales row is
  --    touched: store_id moves no sum, so its recompute would be a no-op,
  --    but each recompute re-checks the sale's keys and CHECKs. Only an
  --    enabled trigger is toggled, and it is put back exactly as found; on
  --    any error the whole transaction (and the toggle) rolls back.
  if exists (select 1 from public.sale_payments where store_id is null) then
    select t.tgenabled into v_sync from pg_trigger t
     where t.tgrelid = 'public.sale_payments'::regclass
       and t.tgname = 'sale_payments_sync' and not t.tgisinternal;
    if v_sync = 'O' then
      alter table public.sale_payments disable trigger sale_payments_sync;
    end if;
    update public.sale_payments sp
       set store_id = s.store_id
      from public.sales s
     where s.id = sp.sale_id and sp.store_id is null;
    if v_sync = 'O' then
      alter table public.sale_payments enable trigger sale_payments_sync;
    end if;
  end if;
  alter table public.sale_payments alter column store_id set not null;

  -- b) the three actor keys.
  for rec in
    select * from (values
      ('sale_payments', 'recorded_by', 'sale_payments_recorded_by_staff_fkey'),
      ('sales',         'voided_by',   'sales_voided_by_staff_fkey'),
      ('shift_closes',  'closed_by',   'shift_closes_closed_by_staff_fkey')
    ) as t(tbl, col, cname)
  loop
    select a.attnum into v_att
      from pg_attribute a
     where a.attrelid = format('public.%I', rec.tbl)::regclass
       and a.attname = rec.col and not a.attisdropped;

    -- New key first (NOT VALID: no scan, no abort on old rows) ...
    if not exists (select 1 from pg_constraint
                    where conrelid = format('public.%I', rec.tbl)::regclass
                      and conname = rec.cname) then
      execute format('alter table public.%I add constraint %I foreign key (%I)
                        references public.users(id) on delete set null not valid',
                     rec.tbl, rec.cname, rec.col);
    end if;

    -- ... then the old one, found by its column (the name was generated).
    for v_con in
      select c.conname from pg_constraint c
       where c.conrelid = format('public.%I', rec.tbl)::regclass
         and c.contype = 'f'
         and c.conkey = array[v_att]
         and c.confrelid = 'auth.users'::regclass
    loop
      execute format('alter table public.%I drop constraint %I', rec.tbl, v_con);
      raise notice '032: dropped % on public.%.% (it referenced auth.users)', v_con, rec.tbl, rec.col;
    end loop;

    if exists (select 1 from pg_constraint
                where conrelid = format('public.%I', rec.tbl)::regclass
                  and conname = rec.cname and not convalidated) then
      begin
        execute format('alter table public.%I validate constraint %I', rec.tbl, rec.cname);
      exception when foreign_key_violation then
        raise warning 'lensy: constraint public.% is NOT valid - some rows name a sign-in that is not staff. New rows are checked anyway, and an orphaned row is checked again on its next update. List them with: select id, % from public.% t where t.% is not null and not exists (select 1 from public.users u where u.id = t.%); then set them to NULL (or to the staff id) and run: select public._repoint_actor_keys();',
          rec.cname, rec.col, rec.tbl, rec.col, rec.col;
      end;
    end if;
  end loop;
end $$;

revoke execute on function public._repoint_actor_keys() from public, anon, authenticated, service_role;

-- ============================================================
-- 5) run it (store_id backfill + NOT NULL, then the actor keys)
-- ============================================================
select public._repoint_actor_keys();

-- ============================================================
-- 6) receive_purchase: average against the stock held BEFORE the delivery
-- ============================================================
-- 029:589-678 with only the cost_price update changed. The movement insert
-- above it fires stock_qty_sync, so stock_qty already includes v_row.qty.
create or replace function public.receive_purchase(p_purchase uuid)
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_store  uuid;
  v_count  integer := 0;
  v_row    record;
  v_old    numeric;   -- stock held before this line's delivery
begin
  perform public.require_perm('suppliers.edit');
  if not public.is_platform_admin() and not public.license_write_ok(public.auth_store_id()) then raise exception 'Store licence does not allow writes'; end if;
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
    -- Only when the shelf was empty (or negative) does it take the new cost.
    -- stock_qty already includes this delivery (stock_qty_sync ran on the
    -- insert above), so what was held BEFORE it is stock_qty - qty.
    select coalesce(i.stock_qty, 0) - v_row.qty into v_old
      from public.inventory i
     where i.id = v_row.product_id and i.store_id = v_store;

    update public.inventory
       set cost_price = case
             when v_old > 0
               then round(
                      ( v_old * coalesce(cost_price, 0)
                        + v_row.qty * coalesce(v_row.unit_cost, 0)
                      ) / ( v_old + v_row.qty )::numeric
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

-- ============================================================
-- 7) settings: the global key goes (031's per-store key stays)
-- ============================================================
create unique index if not exists settings_store_key_key
  on public.settings (store_id, key);

-- Found by column like 031 did (000 declared it inline as `key ... UNIQUE`).
do $$
declare v_con text;
begin
  for v_con in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.settings'::regclass
       and c.contype = 'u'
       and array_length(c.conkey, 1) = 1
       and a.attname = 'key'
  loop
    execute format('alter table public.settings drop constraint %I', v_con);
    raise notice '032: dropped global unique % on settings.key', v_con;
  end loop;
end $$;

-- ============================================================
-- 8) stamp THIS migration (020 makes an unstamped file a red build)
-- ============================================================
select public.record_schema_version(32, 'actor core: store-guarded resolve_can/is_store_admin over internal _resolve_can_for/_is_store_admin_for, tender_key, _z_report under z_report, actor FKs to public.users, sale_payments.store_id not null, weighted cost before the delivery, global settings key dropped');
commit;
