-- LensyPOS — 014: server-side authority (PHASED_ROADMAP Phase 3)
-- ============================================================
-- Phases 1–2 made the database the authority on what a sale is and what may
-- undo one. Phase 3 finishes the job for PEOPLE. Today every permission check
-- lives in a React provider: `perms.can('…')`. That is a courtesy - open
-- DevTools, POST to /rest/v1/role_permissions, and grant yourself anything.
-- Concretely, four holes:
--
--   1. `permissions` is `for all … using (true) with check (true)` (008:375)
--      and `role_permissions` / `user_permissions` keep 001's blanket policy,
--      so ANY signed-in cashier can rewrite the permission catalogue and the
--      role matrix - across every store.
--   2. `auth_store_id()` (008:176-183) resolves a store by
--      `u.id = auth.uid() OR u.username = <email local part>` with `limit 1`
--      and no ordering. A username that exists in two stores makes the
--      tenant a coin flip, and every policy downstream trusts that answer.
--   3. There is no SQL equivalent of the permission check at all, so the
--      database cannot ask "may this person do this?".
--   4. The `create-user` Edge Function takes `role_id` and `store_id` from
--      the caller, so any signed-in user can mint an admin account in another
--      tenant (the function itself is fixed in this phase's companion commit).
--
-- What changes:
--   • `resolve_can(code, user)` — the SQL mirror of the app's `resolveCan`,
--     plus the admin/owner and superadmin bypasses. It does NOT copy the app's
--     "no position = allow everything" break-glass: the UI grants everything
--     so a login is never bricked over bookkeeping, while the database
--     refuses. The Phase 3 gate asserts that divergence on purpose.
--   • `require_perm(code)` — raises with the code in the message, so a
--     failure inside a SECURITY DEFINER function is diagnosable instead of
--     surfacing later as a confusing "permission denied for table sales".
--   • The three RBAC tables get tenant-scoped policies that join through
--     `roles.store_id` / `users.store_id` (neither table has a store_id of
--     its own), and the catalogue becomes read-only for staff.
--   • `auth_store_id()` keeps its username fallback - legacy rows exist whose
--     `users.id` does not match their auth identity - but only when that
--     username is unique across ALL stores, and the id match always wins.
--     An ambiguous username now resolves to NO store (a hard failure, which
--     every policy already treats as deny) instead of a random tenant.
--   • `require_perm` at the top of the privileged RPCs: voiding, and the two
--     purchase deletes.
--   • An `audit_log`, so this phase's own changes are reviewable.
--
-- DELIBERATELY NOT DONE: `resolve_can` is NOT wired into the ordinary read
-- policies. Reads are already tenant-scoped by RLS, and gating them on the
-- permission matrix would lock a whole shop out of History the moment one
-- grant is mistyped. Enforcement goes on privileged WRITES and inside the
-- privileged RPCs; the TSX gates stay as UX.
--
-- REQUIRES 013. Idempotent: safe to run more than once.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (after 013).
-- ============================================================

-- ============================================================
-- 1) audit_log
-- ============================================================
-- Built before more permissions, not after: a permission system nobody can
-- review is just a slower way to lose data. Fed by a trigger, so it cannot be
-- forgotten at a call site.

create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      uuid,                       -- auth.uid() of whoever did it
  store_id   uuid,
  table_name text not null,
  row_id     text,
  action     text not null,              -- insert | update | delete
  before_row jsonb,
  after_row  jsonb
);

create index if not exists audit_log_at_idx    on public.audit_log (at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor, at desc);
create index if not exists audit_log_table_idx on public.audit_log (table_name, at desc);

-- Platform admins read the whole trail; a store reads its own rows. Staff
-- never write it directly - only the trigger does.
alter table public.audit_log enable row level security;
-- NOT `force`: audit_row() is SECURITY DEFINER and runs as the table owner,
-- and FORCE would subject the owner to the SELECT-only policy below, so the
-- trigger could not write its own row. Clients are still fully blocked: the
-- only policy is `for select`, so anon/authenticated can never insert here.
drop policy if exists lensy_audit_read on public.audit_log;
create policy lensy_audit_read on public.audit_log for select to authenticated
  using (public.is_platform_admin() or store_id = public.auth_store_id());

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
begin
  begin
    v_store := coalesce(nullif(to_jsonb(new) ->> 'store_id', '')::uuid,
                        nullif(to_jsonb(old) ->> 'store_id', '')::uuid,
                        public.auth_store_id());
  exception when others then
    v_store := public.auth_store_id();
  end;

  insert into public.audit_log
    (actor, store_id, table_name, row_id, action, before_row, after_row)
  values (
    auth.uid(), v_store, tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    lower(tg_op),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

-- ============================================================
-- 2) resolve_can / require_perm
-- ============================================================
-- The rule, stated once, mirroring web/src/data/permissions.tsx:
--   * an explicit per-person override ALWAYS wins (allow or deny);
--   * otherwise the answer is exactly what the position grants;
--   * admin / owner positions and the `superadmin` username bypass;
--   * a platform (vendor) admin bypasses, but only about itself.
-- What it deliberately does NOT mirror: the provider's openAccess branch,
-- which allows everything when no position is assigned. The UI grants that
-- so a login is never bricked over bookkeeping; the database refuses. The
-- Phase 3 gate asserts the divergence instead of leaving it to chance.

create or replace function public.resolve_can(
  p_code text,
  p_user uuid default auth.uid()
) returns boolean
language sql stable security definer set search_path = public as $fn$
  with me as (
    select u.id, u.username, u.role_id, lower(coalesce(r.name, '')) as role_name
      from public.users u
      left join public.roles r on r.id = u.role_id
     where u.id = p_user
  ),
  override as (
    select up.allow
      from public.user_permissions up
      join public.permissions p on p.id = up.permission_id
     where up.user_id = (select id from me)
       and p.code = p_code
  ),
  granted as (
    select true as ok
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
     where rp.role_id = (select role_id from me)
       and rp.role_id is not null
       and p.code = p_code
  )
  select
    (p_user is not distinct from auth.uid() and public.is_platform_admin())
    or lower(coalesce((select role_name from me), '')) in ('admin', 'owner')
    or lower(trim(coalesce((select username from me), ''))) = 'superadmin'
    or coalesce((select allow from override), (select ok from granted), false)
$fn$;

-- Raise rather than return false: inside a SECURITY DEFINER function a
-- silent false turns into "permission denied for table sales" much later,
-- with nothing to connect it to the code that was actually missing.
create or replace function public.require_perm(p_code text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.resolve_can(p_code) then
    raise exception 'insufficient permission: %', p_code using errcode = '42501';
  end if;
end $$;

-- Helpers the tenant policies below share. Both are defined BEFORE the
-- policies that call them: PostgreSQL validates a policy's expression at
-- CREATE POLICY time, so a function that does not exist yet is an error, not
-- a late surprise.
-- Helper the tenant policies below share: the store that owns a role row.
create or replace function public.role_store(p_role uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select r.store_id from public.roles r where r.id = p_role
$$;
create or replace function public.user_store(p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select u.store_id from public.users u where u.id = p_user
$$;


-- ============================================================
-- 3) the RBAC tables stop being world-writable
-- ============================================================
-- Neither role_permissions nor user_permissions has a store_id of its own
-- (004:24-39), so their policies JOIN through roles.store_id /
-- users.store_id rather than pretending the column exists.

alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;
drop policy if exists lensy_authenticated_all on public.role_permissions;
drop policy if exists lensy_tenant_read    on public.role_permissions;
drop policy if exists lensy_tenant_insert  on public.role_permissions;
drop policy if exists lensy_tenant_update  on public.role_permissions;
drop policy if exists lensy_tenant_delete  on public.role_permissions;

create policy lensy_tenant_read on public.role_permissions for select to authenticated
  using (public.is_platform_admin()
         or (public.role_store(role_id) = public.auth_store_id()
             and (select public.license_read_ok(public.role_store(role_id)))));

-- Writes to the role matrix are a management action, not a cashier action.
create policy lensy_tenant_write on public.role_permissions for insert to authenticated
  with check (public.is_platform_admin()
              or (public.resolve_can('staff.edit')
                  and public.role_store(role_id) = public.auth_store_id()
                  and (select public.license_write_ok(public.auth_store_id()))));
create policy lensy_tenant_update on public.role_permissions for update to authenticated
  using (public.is_platform_admin()
         or (public.resolve_can('staff.edit')
             and public.role_store(role_id) = public.auth_store_id()
             and (select public.license_write_ok(public.auth_store_id()))))
  with check (public.is_platform_admin()
              or (public.resolve_can('staff.edit')
                  and public.role_store(role_id) = public.auth_store_id()
                  and (select public.license_write_ok(public.auth_store_id()))));
create policy lensy_tenant_delete on public.role_permissions for delete to authenticated
  using (public.is_platform_admin()
         or (public.resolve_can('staff.edit')
             and public.role_store(role_id) = public.auth_store_id()
             and (select public.license_write_ok(public.auth_store_id()))));

alter table public.user_permissions enable row level security;
alter table public.user_permissions force row level security;
drop policy if exists lensy_authenticated_all on public.user_permissions;
drop policy if exists lensy_tenant_read    on public.user_permissions;
drop policy if exists lensy_tenant_insert  on public.user_permissions;
drop policy if exists lensy_tenant_update  on public.user_permissions;
drop policy if exists lensy_tenant_delete  on public.user_permissions;

-- An override is ABOUT one person, so its scope is that person's store.
create policy lensy_tenant_read on public.user_permissions for select to authenticated
  using (public.is_platform_admin()
         or (public.user_store(user_id) = public.auth_store_id()
             and (select public.license_read_ok(public.user_store(user_id)))));
create policy lensy_tenant_insert on public.user_permissions for insert to authenticated
  with check (public.is_platform_admin()
              or (public.resolve_can('staff.edit')
                  and public.user_store(user_id) = public.auth_store_id()
                  and (select public.license_write_ok(public.auth_store_id()))));
create policy lensy_tenant_update on public.user_permissions for update to authenticated
  using (public.is_platform_admin()
         or (public.resolve_can('staff.edit')
             and public.user_store(user_id) = public.auth_store_id()
             and (select public.license_write_ok(public.auth_store_id()))))
  with check (public.is_platform_admin()
              or (public.resolve_can('staff.edit')
                  and public.user_store(user_id) = public.auth_store_id()
                  and (select public.license_write_ok(public.auth_store_id()))));
create policy lensy_tenant_delete on public.user_permissions for delete to authenticated
  using (public.is_platform_admin()
         or (public.resolve_can('staff.edit')
             and public.user_store(user_id) = public.auth_store_id()
             and (select public.license_write_ok(public.auth_store_id()))));

-- The catalogue stays READABLE by every signed-in user: the Access Control
-- matrix renders the code list, and locking that out would break the Staff
-- screen for everyone. Writes go to platform admins only - a code list is not
-- something a shop manager should be able to invent.
alter table public.permissions enable row level security;
alter table public.permissions force row level security;
drop policy if exists lensy_authenticated_all on public.permissions;
drop policy if exists lensy_catalog_read on public.permissions;
create policy lensy_catalog_read on public.permissions for select to authenticated
  using (true);
create policy lensy_catalog_write on public.permissions for insert to authenticated
  with check (public.is_platform_admin());
create policy lensy_catalog_update on public.permissions for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy lensy_catalog_delete on public.permissions for delete to authenticated
  using (public.is_platform_admin());


-- ============================================================
-- 4) auth_store_id(): the id match wins, and ambiguity is a hard failure
-- ============================================================
-- Before (008:176-183):
--   where u.id = auth.uid() or u.username = split_part(email,'@',1) limit 1
-- With no ORDER BY, a username that exists in two stores picks a tenant at
-- random, and every policy in the database trusts this answer.
--
-- Now: the id match is authoritative and always preferred; the username
-- fallback survives for genuinely legacy rows (public.users.id that does not
-- match the auth identity) but ONLY when the username is unique across every
-- store. An ambiguous username resolves to NO store - which every policy
-- already treats as deny - instead of to the wrong tenant.
--
-- Kept rather than cut on purpose: deleting the fallback outright would lock
-- out any real user whose users.id is stale, and a locked-out shop is a worse
-- outcome than a narrowed one.

create or replace function public.auth_store_id() returns uuid
language sql stable security definer set search_path = public, auth as $$
  select u.store_id
    from public.users u
   where u.id = auth.uid()
  union all
  -- fallback, only for identities with no row of their own
  select u.store_id
    from public.users u
   where u.id is distinct from auth.uid()
     and u.username = split_part(coalesce((select email from auth.users where id = auth.uid()), ''), '@', 1)
     and (select count(*) from public.users u2
           where u2.username = u.username) = 1
  limit 1
$$;

-- ============================================================
-- 5) seed the `void` codes
-- ============================================================
-- migration 013 added a `void` action in the app (permissions.tsx ACTIONS).
-- The catalogue is now read-only for staff, so the codes must exist here or
-- the Access Control matrix would show a column nobody can grant, and the
-- app's "create the code on the fly" path would fail on the read-only policy.

insert into public.permissions (code, name)
select r.resource || '.void', 'Void on ' || r.resource
  from (values
    ('pos'), ('customers'), ('inventory'), ('lab'),
    ('history'), ('reports'), ('suppliers'), ('notes'),
    ('staff'), ('settings')
  ) as r(resource)
on conflict (code) do nothing;

-- ============================================================
-- 6) require_perm at the top of the privileged RPCs
-- ============================================================
-- 013 already made these SECURITY DEFINER (so they bypass RLS); that is
-- exactly why they must now check the permission themselves. Redefined here
-- rather than edited in 013, which is already applied.

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

  -- one refund per original tender, so the per-method cash-up stays truthful
  insert into public.sale_payments
    (sale_id, amount, method, kind, note, paid_at, store_id, recorded_by)
  select p_sale_id, -sp.amount, sp.method, 'refund',
         'Void ' || coalesce(v_sale.invoice_no, ''),
         now(), v_sale.store_id, auth.uid()
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

-- The purchase deletes are privileged for the same reason. Kept otherwise
-- byte-for-byte: 013's gate proves their behaviour, and re-deriving them here
-- would only give CI something new to disagree about.
create or replace function public.delete_purchase(p_purchase uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_count integer;
begin
  perform public.require_perm('purchases.delete');
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
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_count integer;
begin
  perform public.require_perm('purchases.edit');
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
-- 7) the audit trail, attached
-- ============================================================
-- The money and authority tables, and only those: a trail on every table
-- would bury the entries that matter.

do $$
declare t text;
begin
  foreach t in array array[
    'sales','sale_items','sale_payments','stock_movements',
    'purchases','purchase_items','purchase_payments',
    'role_permissions','user_permissions','users','roles'
  ] loop
    execute format('drop trigger if exists audit_row_trigger on public.%I', t);
    execute format(
      'create trigger audit_row_trigger after insert or update or delete on public.%I'
      ' for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ============================================================
-- 8) grants
-- ============================================================

grant execute on function public.resolve_can(text, uuid) to authenticated;
grant execute on function public.require_perm(text) to authenticated;
grant execute on function public.role_store(uuid) to authenticated;
grant execute on function public.user_store(uuid) to authenticated;
grant select on public.audit_log to authenticated;
-- The trigger function is SECURITY DEFINER and must never be callable
-- directly, or anyone could log a forgery.
revoke execute on function public.audit_row() from public, anon, authenticated;
