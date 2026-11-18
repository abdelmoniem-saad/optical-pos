-- LensyPOS — 011: multi-store hardening + single shop register
-- ============================================================
-- 1) Names/numbers are unique PER STORE (they were unique across ALL stores,
--    so a second store could not have invoice 000001, a "Black" frame colour,
--    an "Admin" position, a product SKU already used by another store...).
--    settings.key keeps its old global rule until 012 (see the note there).
-- 2) A login maps to a staff row (and so to a store) by its own id, by an
--    explicit users.auth_uid link, or - for staff logins - by the exact email
--    <username>@lensypos.local. Before, ANY email whose part before '@'
--    matched a username (e.g. admin@anything) became that staff member.
-- 3) Position/person permission rows are visible and editable only inside
--    their own store; the permission catalogue is read-only except for the
--    vendor (platform admins).
-- 4) One register per store: the shop PC (offline mode) claims the store's
--    register slot; a second PC can only take over explicitly.
-- 5) Row-level security calls auth_store_id() once per query, not once per
--    row (faster full downloads for the shop PC).
--
-- Idempotent: safe to run more than once. Run AFTER 001-010.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.
--
-- IMPORTANT: staff logins use the domain 'lensypos.local' (VITE_AUTH_EMAIL_DOMAIN).
-- If your project uses another domain, replace 'lensypos.local' below first.

-- ============================================================
-- 1) PER-STORE UNIQUENESS
-- ============================================================
do $$
declare
  spec record;
  con record;
  attn smallint;
begin
  for spec in
    select * from (values
      ('sales',        'invoice_no', 'sales_store_invoice_no_key',  true),
      ('inventory',    'sku',        'inventory_store_sku_key',     true),
      ('roles',        'name',       'roles_store_name_key',        true),
      ('lens_types',   'name',       'lens_types_store_name_key',   true),
      ('frame_types',  'name',       'frame_types_store_name_key',  true),
      ('frame_colors', 'name',       'frame_colors_store_name_key', true),
      -- settings: per-store rule added now; the old global one is dropped in 012.
      ('settings',     'key',        'settings_store_key_key',      false)
    ) as t(tbl, col, newname, drop_global)
  loop
    if to_regclass('public.' || spec.tbl) is null then
      raise notice 'skipping missing table: %', spec.tbl;
      continue;
    end if;
    -- a) the per-store rule
    if not exists (
      select 1 from pg_constraint
      where conname = spec.newname and conrelid = ('public.' || spec.tbl)::regclass
    ) then
      begin
        execute format('alter table public.%I add constraint %I unique (store_id, %I)',
                       spec.tbl, spec.newname, spec.col);
      exception when unique_violation then
        -- Existing duplicates inside one store: leave this table exactly as it is.
        raise warning 'LensyPOS 011: % has duplicate % values within a store - fix them and run 011 again. Table left unchanged.',
          spec.tbl, spec.col;
        continue;
      end;
    end if;
    if not spec.drop_global then continue; end if;

    select attnum into attn from pg_attribute
    where attrelid = ('public.' || spec.tbl)::regclass and attname = spec.col and not attisdropped;

    -- b) drop the old single-column UNIQUE constraint(s)
    for con in
      select c.conname from pg_constraint c
      where c.conrelid = ('public.' || spec.tbl)::regclass
        and c.contype = 'u'
        and c.conkey = array[attn]
    loop
      execute format('alter table public.%I drop constraint %I', spec.tbl, con.conname);
    end loop;

    -- c) and any stand-alone unique index on just that column
    for con in
      select i.indexrelid::regclass::text as idx from pg_index i
      where i.indrelid = ('public.' || spec.tbl)::regclass
        and i.indisunique and not i.indisprimary
        and i.indnatts = 1 and i.indkey[0] = attn
        and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
    loop
      execute format('drop index %s', con.idx);
    end loop;
  end loop;
end $$;

-- An empty SKU means "no SKU" (two products without one must not collide).
update public.inventory set sku = null where sku is not null and btrim(sku) = '';

-- ============================================================
-- 2) WHICH STAFF ROW (AND STORE) A LOGIN BELONGS TO
-- ============================================================
alter table public.users add column if not exists auth_uid uuid;
create unique index if not exists users_auth_uid_key on public.users (auth_uid) where auth_uid is not null;

-- Keep every link that works today: a legacy staff row (its id is not the
-- login's id) linked by name to exactly one existing login gets an explicit
-- auth_uid. Review the result afterwards (query at the end of this file).
update public.users u
set auth_uid = a.id
from auth.users a
where u.auth_uid is null
  and u.id <> a.id
  and not exists (select 1 from public.users own where own.id = a.id)
  and lower(u.username) = lower(split_part(a.email, '@', 1))
  and (select count(*) from auth.users a2
       where lower(split_part(a2.email, '@', 1)) = lower(u.username)) = 1;

create or replace function public.auth_staff_id() returns uuid
language sql stable security definer set search_path = public, auth as $$
  with me as (select id, lower(email) as email from auth.users where id = auth.uid())
  select u.id
  from public.users u, me
  where u.id = me.id
     or u.auth_uid = me.id
     or lower(case when u.username like '%@%' then u.username
                   else u.username || '@lensypos.local' end) = me.email
  order by (u.id = me.id) desc, (u.auth_uid = me.id) desc nulls last
  limit 1
$$;

create or replace function public.auth_store_id() returns uuid
language sql stable security definer set search_path = public, auth as $$
  select u.store_id from public.users u where u.id = public.auth_staff_id()
$$;

grant execute on function public.auth_staff_id() to authenticated;
grant execute on function public.auth_store_id() to authenticated;

-- ============================================================
-- 3) RLS: evaluate the tenant functions once per query
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'customers','sales','sale_items','order_examinations','prescriptions',
    'inventory','stock_movements','suppliers','purchases','purchase_items',
    'purchase_payments','notes','note_seen','users','roles','settings',
    'warehouses','lens_types','frame_colors','frame_types'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists lensy_tenant_read on public.%I', t);
    execute format('drop policy if exists lensy_tenant_insert on public.%I', t);
    execute format('drop policy if exists lensy_tenant_update on public.%I', t);
    execute format('drop policy if exists lensy_tenant_delete on public.%I', t);
    execute format($p$
      create policy lensy_tenant_read on public.%I for select to authenticated
      using (
        (select public.is_platform_admin())
        or (store_id = (select public.auth_store_id()) and (select public.license_read_ok(store_id)))
      )
    $p$, t);
    execute format($p$
      create policy lensy_tenant_insert on public.%I for insert to authenticated
      with check (
        (select public.is_platform_admin())
        or (store_id = (select public.auth_store_id()) and (select public.license_write_ok(store_id)))
      )
    $p$, t);
    execute format($p$
      create policy lensy_tenant_update on public.%I for update to authenticated
      using (
        (select public.is_platform_admin())
        or (store_id = (select public.auth_store_id()) and (select public.license_read_ok(store_id)))
      )
      with check (
        (select public.is_platform_admin())
        or (store_id = (select public.auth_store_id()) and (select public.license_write_ok(store_id)))
      )
    $p$, t);
    execute format($p$
      create policy lensy_tenant_delete on public.%I for delete to authenticated
      using (
        (select public.is_platform_admin())
        or (store_id = (select public.auth_store_id()) and (select public.license_write_ok(store_id)))
      )
    $p$, t);
  end loop;
end $$;

-- ============================================================
-- 4) PERMISSIONS: store-scoped grants, read-only catalogue
-- ============================================================
drop policy if exists lensy_authenticated_all on public.role_permissions;
drop policy if exists lensy_rbac_read on public.role_permissions;
drop policy if exists lensy_rbac_insert on public.role_permissions;
drop policy if exists lensy_rbac_update on public.role_permissions;
drop policy if exists lensy_rbac_delete on public.role_permissions;
create policy lensy_rbac_read on public.role_permissions for select to authenticated using (
  (select public.is_platform_admin()) or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and r.store_id = (select public.auth_store_id())
      and public.license_read_ok(r.store_id)));
create policy lensy_rbac_insert on public.role_permissions for insert to authenticated with check (
  (select public.is_platform_admin()) or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and r.store_id = (select public.auth_store_id())
      and public.license_write_ok(r.store_id)));
create policy lensy_rbac_update on public.role_permissions for update to authenticated
  using ((select public.is_platform_admin()) or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id and r.store_id = (select public.auth_store_id())))
  with check ((select public.is_platform_admin()) or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and r.store_id = (select public.auth_store_id())
      and public.license_write_ok(r.store_id)));
create policy lensy_rbac_delete on public.role_permissions for delete to authenticated using (
  (select public.is_platform_admin()) or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and r.store_id = (select public.auth_store_id())
      and public.license_write_ok(r.store_id)));

drop policy if exists lensy_authenticated_all on public.user_permissions;
drop policy if exists lensy_rbac_read on public.user_permissions;
drop policy if exists lensy_rbac_insert on public.user_permissions;
drop policy if exists lensy_rbac_update on public.user_permissions;
drop policy if exists lensy_rbac_delete on public.user_permissions;
create policy lensy_rbac_read on public.user_permissions for select to authenticated using (
  (select public.is_platform_admin()) or exists (
    select 1 from public.users u
    where u.id = user_permissions.user_id
      and u.store_id = (select public.auth_store_id())
      and public.license_read_ok(u.store_id)));
create policy lensy_rbac_insert on public.user_permissions for insert to authenticated with check (
  (select public.is_platform_admin()) or exists (
    select 1 from public.users u
    where u.id = user_permissions.user_id
      and u.store_id = (select public.auth_store_id())
      and public.license_write_ok(u.store_id)));
create policy lensy_rbac_update on public.user_permissions for update to authenticated
  using ((select public.is_platform_admin()) or exists (
    select 1 from public.users u
    where u.id = user_permissions.user_id and u.store_id = (select public.auth_store_id())))
  with check ((select public.is_platform_admin()) or exists (
    select 1 from public.users u
    where u.id = user_permissions.user_id
      and u.store_id = (select public.auth_store_id())
      and public.license_write_ok(u.store_id)));
create policy lensy_rbac_delete on public.user_permissions for delete to authenticated using (
  (select public.is_platform_admin()) or exists (
    select 1 from public.users u
    where u.id = user_permissions.user_id
      and u.store_id = (select public.auth_store_id())
      and public.license_write_ok(u.store_id)));

-- The catalogue of permission codes: everyone reads, only the vendor writes.
drop policy if exists lensy_authenticated_all on public.permissions;
drop policy if exists lensy_permissions_read on public.permissions;
drop policy if exists lensy_permissions_write on public.permissions;
create policy lensy_permissions_read on public.permissions for select to authenticated using (true);
create policy lensy_permissions_write on public.permissions for all to authenticated
  using ((select public.is_platform_admin())) with check ((select public.is_platform_admin()));

-- Every code the app uses (same list as 004; nothing changes if present).
insert into public.permissions (code, name)
select r || '.' || a, initcap(a) || ' ' || r
from unnest(array['dashboard','pos','customers','inventory','lab','history','reports',
                  'suppliers','notes','staff','settings']) as r,
     unnest(array['view','create','edit','delete']) as a
on conflict (code) do nothing;

-- ============================================================
-- 5) ONE REGISTER PER STORE (the shop PC in offline mode)
-- ============================================================
create table if not exists public.store_registers (
    store_id uuid primary key references public.stores(id) on delete cascade,
    device_id uuid not null,
    claimed_by uuid,
    claimed_at timestamptz not null default now()
);
-- Only the functions below touch it.
alter table public.store_registers enable row level security;
alter table public.store_registers force row level security;

create or replace function public.claim_register(p_device uuid, p_takeover boolean default false)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.auth_store_id();
  v_current uuid;
begin
  if v_store is null then
    raise exception 'This account is not linked to a store.';
  end if;
  -- Store admins only (Admin/Owner position, the superadmin account, or no position).
  if not exists (
    select 1 from public.users u left join public.roles r on r.id = u.role_id
    where u.id = public.auth_staff_id()
      and coalesce(u.is_active, true)
      and (u.role_id is null or lower(r.name) in ('admin', 'owner') or lower(u.username) = 'superadmin')
  ) then
    raise exception 'Only a store admin account can link the register computer.';
  end if;
  select device_id into v_current from public.store_registers where store_id = v_store;
  if v_current is not null and v_current <> p_device and not p_takeover then
    return false;
  end if;
  insert into public.store_registers (store_id, device_id, claimed_by, claimed_at)
  values (v_store, p_device, auth.uid(), now())
  on conflict (store_id) do update
    set device_id = excluded.device_id, claimed_by = excluded.claimed_by, claimed_at = now();
  return true;
end $$;

-- true = this PC is the register; false = another PC is; null = none claimed yet.
create or replace function public.register_is_current(p_device uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select (select device_id from public.store_registers where store_id = public.auth_store_id()) = p_device
$$;

grant execute on function public.claim_register(uuid, boolean) to authenticated;
grant execute on function public.register_is_current(uuid) to authenticated;

-- ============================================================
-- REVIEW AFTER RUNNING (optional): the legacy name links kept above.
--   select u.username, u.store_id, a.email
--   from public.users u join auth.users a on a.id = u.auth_uid;
-- Every row should be one of YOUR staff. If one is not, clear it:
--   update public.users set auth_uid = null where username = '...';
-- ============================================================
