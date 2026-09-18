-- LensyPOS — 008: multi-tenancy foundation
-- ========================================
-- Multiple stores in ONE Supabase project, isolated by Postgres itself:
--   • stores            — one row per shop (the tenant)
--   • platform_admins   — the VENDOR's accounts (see/manage everything)
--   • store_id          — added to EVERY store-scoped table + backfilled
--   • auth_store_id()   — the signed-in user's store (definer function)
--   • license_read_ok()/license_write_ok() — per-store subscription state
--   • RLS v2            — tenant + license policies on every table
--   • Storage           — all files move under store/<store_id>/..., scoped
--
-- The CURRENT shop becomes the default store ('Main Store'); every existing
-- row (and storage file) is backfilled to it, so the existing owner notices
-- nothing except a new store id.
--
-- Security model: a signed-in user can only ever touch rows of their own
-- store, and only while that store's license allows it. Even a buggy query
-- or a hand-crafted API request cannot cross stores - Postgres enforces it.
--
-- Idempotent: safe to run multiple times.
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run (then 009).

-- ============================================================
-- 1) TENANT TABLES
-- ============================================================

create table if not exists public.stores (
    id uuid primary key default uuid_generate_v4(),
    name text not null,
    owner_name text,
    owner_phone text,
    owner_email text,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.store_licenses (
    id uuid primary key default uuid_generate_v4(),
    store_id uuid not null references public.stores(id) on delete cascade,
    license_key text not null unique,
    plan text not null default 'standard',   -- 'trial' | 'standard' | 'pro'
    max_staff integer,                       -- NULL = unlimited
    is_revoked boolean not null default false,
    features jsonb not null default '{}',
    starts_at timestamptz not null default now(),
    expires_at timestamptz,                  -- NULL = perpetual
    notes text,
    created_at timestamptz not null default now(),
    unique (store_id)
);

create table if not exists public.platform_admins (
    auth_uid uuid primary key references auth.users(id) on delete cascade,
    name text,
    created_at timestamptz not null default now()
);

-- The reserved 'superadmin' account becomes a platform admin automatically.
insert into public.platform_admins (auth_uid, name)
select u.id, coalesce(u.full_name, u.username)
from public.users u
where u.username = 'superadmin'
on conflict (auth_uid) do nothing;

-- ============================================================
-- 2) DEFAULT STORE (the current shop)
-- ============================================================

insert into public.stores (name, owner_name)
select 'Main Store', 'Owner'
where not exists (select 1 from public.stores);

-- ============================================================
-- 3) store_id COLUMNS + BACKFILL
-- ============================================================

alter table public.customers        add column if not exists store_id uuid;
alter table public.sales            add column if not exists store_id uuid;
alter table public.sale_items       add column if not exists store_id uuid;
alter table public.order_examinations add column if not exists store_id uuid;
alter table public.prescriptions    add column if not exists store_id uuid;
alter table public.inventory        add column if not exists store_id uuid;
alter table public.stock_movements  add column if not exists store_id uuid;
alter table public.suppliers        add column if not exists store_id uuid;
alter table public.purchases        add column if not exists store_id uuid;
alter table public.purchase_items   add column if not exists store_id uuid;
alter table public.purchase_payments add column if not exists store_id uuid;
alter table public.notes            add column if not exists store_id uuid;
alter table public.note_seen        add column if not exists store_id uuid;
alter table public.users            add column if not exists store_id uuid;
alter table public.roles            add column if not exists store_id uuid;
alter table public.settings         add column if not exists store_id uuid;
alter table public.warehouses       add column if not exists store_id uuid;
alter table public.lens_types       add column if not exists store_id uuid;
alter table public.frame_colors     add column if not exists store_id uuid;
alter table public.frame_types      add column if not exists store_id uuid;

-- Backfill: everything existing belongs to the default store...
do $$
declare d uuid;
begin
  select id into d from public.stores order by created_at limit 1;

  update public.customers         set store_id = d where store_id is null;
  update public.sales             set store_id = d where store_id is null;
  update public.inventory         set store_id = d where store_id is null;
  update public.suppliers         set store_id = d where store_id is null;
  update public.purchases         set store_id = d where store_id is null;
  update public.prescriptions     set store_id = d where store_id is null;
  update public.notes             set store_id = d where store_id is null;
  update public.users             set store_id = d where store_id is null;
  update public.roles             set store_id = d where store_id is null;
  update public.settings          set store_id = d where store_id is null;
  update public.warehouses        set store_id = d where store_id is null;
  update public.lens_types        set store_id = d where store_id is null;
  update public.frame_colors      set store_id = d where store_id is null;
  update public.frame_types       set store_id = d where store_id is null;

  -- children via their parent rows
  update public.sale_items si
     set store_id = s.store_id
    from public.sales s
   where si.sale_id = s.id and si.store_id is null;
  update public.order_examinations oe
     set store_id = s.store_id
    from public.sales s
   where oe.sale_id = s.id and oe.store_id is null;
  update public.purchase_items pi
     set store_id = p.store_id
    from public.purchases p
   where pi.purchase_id = p.id and pi.store_id is null;
  update public.purchase_payments pp
     set store_id = p.store_id
    from public.purchases p
   where pp.purchase_id = p.id and pp.store_id is null;
  update public.note_seen ns
     set store_id = n.store_id
    from public.notes n
   where ns.note_id = n.id and ns.store_id is null;
  update public.stock_movements sm
     set store_id = i.store_id
    from public.inventory i
   where sm.product_id = i.id and sm.store_id is null;
  update public.stock_movements
     set store_id = d
   where store_id is null;
end $$;

-- Required now that every row has a store.
alter table public.customers         alter column store_id set not null;
alter table public.sales             alter column store_id set not null;
alter table public.sale_items        alter column store_id set not null;
alter table public.order_examinations alter column store_id set not null;
alter table public.prescriptions     alter column store_id set not null;
alter table public.inventory         alter column store_id set not null;
alter table public.stock_movements   alter column store_id set not null;
alter table public.suppliers         alter column store_id set not null;
alter table public.purchases         alter column store_id set not null;
alter table public.purchase_items    alter column store_id set not null;
alter table public.purchase_payments alter column store_id set not null;
alter table public.notes             alter column store_id set not null;
alter table public.note_seen         alter column store_id set not null;
alter table public.users             alter column store_id set not null;
alter table public.roles             alter column store_id set not null;
alter table public.settings          alter column store_id set not null;
alter table public.warehouses        alter column store_id set not null;
alter table public.lens_types        alter column store_id set not null;
alter table public.frame_colors      alter column store_id set not null;
alter table public.frame_types       alter column store_id set not null;

-- ============================================================
-- 4) SECURITY FUNCTIONS
-- ============================================================

-- The signed-in user's store (by auth UUID, or by legacy username link).
create or replace function public.auth_store_id() returns uuid
language sql stable security definer set search_path = public, auth as $$
  select u.store_id
  from public.users u
  where u.id = auth.uid()
     or u.username = split_part(coalesce((select email from auth.users where id = auth.uid()), ''), '@', 1)
  limit 1
$$;

-- READ: active license, or the 30-day grace window after expiry.
create or replace function public.license_read_ok(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (is_revoked = false)
       and (expires_at is null or expires_at > now() - interval '30 days')
    from public.store_licenses
    where store_id = p_store
    order by created_at desc
    limit 1
  ), false)
$$;

-- WRITE: active license only. Expired = read-only (print/export), no writes.
create or replace function public.license_write_ok(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (is_revoked = false)
       and (expires_at is null or expires_at > now())
    from public.store_licenses
    where store_id = p_store
    order by created_at desc
    limit 1
  ), false)
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.platform_admins where auth_uid = auth.uid())
$$;

-- License + store info for the signed-in user (drives the app's gate/banner).
create or replace function public.my_license_state()
returns table (state text, plan text, expires_at timestamptz, store_name text)
language sql stable security definer set search_path = public, auth as $$
  select
    case
      when s.id is null then 'none'
      when l.id is null then 'none'
      when l.is_revoked then 'expired'
      when l.expires_at is null or l.expires_at > now() then 'active'
      when l.expires_at > now() - interval '30 days' then 'grace'
      else 'expired'
    end,
    l.plan,
    l.expires_at,
    s.name
  from public.stores s
  left join public.store_licenses l on l.store_id = s.id
  where s.id = public.auth_store_id()
$$;

-- Auto-fill store_id on insert from the signed-in user's store, so the app
-- does not have to pass it on every insert. Service-role callers (Edge
-- Functions) must pass store_id explicitly.
create or replace function public.tenant_fill_store_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.store_id is null then
    new.store_id := public.auth_store_id();
  end if;
  return new;
end $$;

-- ============================================================
-- 5) INSERT TRIGGERS + INDEXES
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
    execute format('drop trigger if exists tenant_fill_store_id on public.%I', t);
    execute format('create trigger tenant_fill_store_id before insert on public.%I
                    for each row execute function public.tenant_fill_store_id()', t);
  end loop;
end $$;

create index if not exists idx_sales_store_date  on public.sales (store_id, order_date desc);
create index if not exists idx_customers_store   on public.customers (store_id);
create index if not exists idx_sale_items_store  on public.sale_items (store_id);
create index if not exists idx_exams_store       on public.order_examinations (store_id);
create index if not exists idx_inventory_store   on public.inventory (store_id);
create index if not exists idx_stock_mv_store    on public.stock_movements (store_id);
create index if not exists idx_suppliers_store   on public.suppliers (store_id);
create index if not exists idx_purchases_store   on public.purchases (store_id);
create index if not exists idx_purchase_it_store on public.purchase_items (store_id);
create index if not exists idx_purchase_pay_st   on public.purchase_payments (store_id);
create index if not exists idx_presc_store       on public.prescriptions (store_id);
create index if not exists idx_notes_store       on public.notes (store_id);
create index if not exists idx_users_store       on public.users (store_id);
create index if not exists idx_roles_store       on public.roles (store_id);

-- ============================================================
-- 6) RLS v2 — tenant + license policies on every store-scoped table
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
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists lensy_authenticated_all on public.%I', t);
    execute format('drop policy if exists lensy_tenant_read on public.%I', t);
    execute format('drop policy if exists lensy_tenant_insert on public.%I', t);
    execute format('drop policy if exists lensy_tenant_update on public.%I', t);
    execute format('drop policy if exists lensy_tenant_delete on public.%I', t);

    -- READ: own store + license read-ok (active or grace), or platform admin.
    execute format($p$
      create policy lensy_tenant_read on public.%I for select to authenticated
      using (
        public.is_platform_admin()
        or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id)))
      )
    $p$, t);
    -- INSERT: license must be ACTIVE (grace/expired stores cannot write).
    execute format($p$
      create policy lensy_tenant_insert on public.%I for insert to authenticated
      with check (
        public.is_platform_admin()
        or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
      )
    $p$, t);
    -- UPDATE: old row readable, new row writable.
    execute format($p$
      create policy lensy_tenant_update on public.%I for update to authenticated
      using (
        public.is_platform_admin()
        or (store_id = public.auth_store_id() and (select public.license_read_ok(store_id)))
      )
      with check (
        public.is_platform_admin()
        or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
      )
    $p$, t);
    -- DELETE: license must be ACTIVE.
    execute format($p$
      create policy lensy_tenant_delete on public.%I for delete to authenticated
      using (
        public.is_platform_admin()
        or (store_id = public.auth_store_id() and (select public.license_write_ok(store_id)))
      )
    $p$, t);
  end loop;
end $$;

-- ============================================================
-- 7) SPECIAL TABLES
-- ============================================================

-- stores: staff read their OWN store row (for the name); writes = platform.
alter table public.stores enable row level security;
alter table public.stores force row level security;
drop policy if exists lensy_authenticated_all on public.stores;
drop policy if exists lensy_stores_read on public.stores;
drop policy if exists lensy_stores_write on public.stores;
create policy lensy_stores_read on public.stores for select to authenticated
  using (public.is_platform_admin() or id = public.auth_store_id());
create policy lensy_stores_write on public.stores for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- store_licenses / platform_admins: platform admins ONLY.
alter table public.store_licenses enable row level security;
alter table public.store_licenses force row level security;
drop policy if exists lensy_platform_all on public.store_licenses;
create policy lensy_platform_all on public.store_licenses for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;
drop policy if exists lensy_platform_all on public.platform_admins;
create policy lensy_platform_all on public.platform_admins for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- permissions: GLOBAL catalog - readable/writable by any authenticated user.
alter table public.permissions enable row level security;
alter table public.permissions force row level security;
drop policy if exists lensy_authenticated_all on public.permissions;
create policy lensy_authenticated_all on public.permissions for all to authenticated
  using (true) with check (true);

-- Retire the desktop-era public policies on the licensing tables: license
-- keys were readable by ANYONE (even anonymous) before this.
drop policy if exists "Allow license lookup" on public.licenses;
drop policy if exists "Allow license update for activation" on public.licenses;
drop policy if exists "Allow read updates" on public.app_updates;
drop policy if exists "Allow insert logs" on public.license_logs;

alter table public.licenses enable row level security;
alter table public.licenses force row level security;
drop policy if exists lensy_platform_read on public.licenses;
create policy lensy_platform_read on public.licenses for select to authenticated
  using (public.is_platform_admin());

alter table public.app_updates enable row level security;
alter table public.app_updates force row level security;
drop policy if exists lensy_platform_read on public.app_updates;
create policy lensy_platform_read on public.app_updates for select to authenticated
  using (public.is_platform_admin());

alter table public.license_logs enable row level security;
alter table public.license_logs force row level security;
drop policy if exists lensy_platform_all on public.license_logs;
create policy lensy_platform_all on public.license_logs for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- ============================================================
-- 8) STORAGE — move files under store/<store_id>/ and scope access
-- ============================================================

update storage.objects
set name = 'store/' || (select id from public.stores order by created_at limit 1) || '/' || name
where bucket_id = 'prescriptions'
  and (storage.foldername(name))[1] is distinct from 'store';

-- Point the stored DB paths at the new locations.
update public.order_examinations
set image_path = 'store/' || (select id from public.stores order by created_at limit 1) || '/' || image_path
where image_path is not null and image_path not like 'store/%';
update public.sales
set rx_image_path = 'store/' || (select id from public.stores order by created_at limit 1) || '/' || rx_image_path
where rx_image_path is not null and rx_image_path not like 'store/%';
update public.sales
set frame_image_path = 'store/' || (select id from public.stores order by created_at limit 1) || '/' || frame_image_path
where frame_image_path is not null and frame_image_path not like 'store/%';
update public.prescriptions
set image_path = 'store/' || (select id from public.stores order by created_at limit 1) || '/' || image_path
where image_path is not null and image_path not like 'store/%';

drop policy if exists lensy_storage_all on storage.objects;
create policy lensy_storage_all on storage.objects
  for all to authenticated
  using (
    bucket_id = 'prescriptions'
    and (
      public.is_platform_admin()
      or (
        (storage.foldername(name))[1] = 'store'
        and (storage.foldername(name))[2] = public.auth_store_id()::text
        and (select public.license_read_ok(public.auth_store_id()))
      )
      -- transitional: the default store may still touch legacy root files
      or (
        public.auth_store_id() = (select id from public.stores order by created_at limit 1)
        and (storage.foldername(name))[1] is distinct from 'store'
      )
    )
  )
  with check (
    bucket_id = 'prescriptions'
    and (
      public.is_platform_admin()
      or (
        (storage.foldername(name))[1] = 'store'
        and (storage.foldername(name))[2] = public.auth_store_id()::text
        and (select public.license_write_ok(public.auth_store_id()))
      )
      or (
        public.auth_store_id() = (select id from public.stores order by created_at limit 1)
        and (storage.foldername(name))[1] is distinct from 'store'
      )
    )
  );
