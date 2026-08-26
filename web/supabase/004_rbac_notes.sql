-- LensyPOS — 004: RBAC control panel + Notes
-- ==========================================
-- 1) Ensures the permission tables exist (same shapes as supabase_full_schema).
-- 2) Seeds the permission universe: <tab>.<action> codes for every screen and
--    the actions view/create/edit/delete.
-- 3) Grants EVERYTHING to admin/owner roles, and — guarded, one-time — to any
--    other existing role that has no configuration yet, so switching on the
--    control panel never locks anyone out.
-- 4) Creates the `notes` table (user_id NULL = visible to everyone).
-- 5) Applies the app's RLS model to all new tables.
--
-- Idempotent: safe to run multiple times.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

-- ---------- 1) tables ----------
create table if not exists public.permissions (
    id uuid primary key default uuid_generate_v4(),
    code text not null unique,
    name text,
    description text
);

create table if not exists public.role_permissions (
    id uuid primary key default uuid_generate_v4(),
    role_id uuid references public.roles(id) on delete cascade,
    permission_id uuid references public.permissions(id) on delete cascade,
    value text,
    unique (role_id, permission_id)
);

create table if not exists public.user_permissions (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid references public.users(id) on delete cascade,
    permission_id uuid references public.permissions(id) on delete cascade,
    allow boolean default true,
    value text,
    unique (user_id, permission_id)
);

create table if not exists public.notes (
    id uuid primary key default uuid_generate_v4(),
    -- NULL = note for the whole team; otherwise private to that user.
    user_id uuid references public.users(id) on delete cascade,
    created_by uuid references public.users(id),
    body text not null,
    created_at timestamptz not null default now()
);

create index if not exists notes_user_idx on public.notes (user_id, created_at desc);

-- ---------- 2) permission universe ----------
insert into public.permissions (code, name)
values
  ('dashboard.view',   'View dashboard'),
  ('dashboard.create', 'Create on dashboard'),
  ('dashboard.edit',   'Edit on dashboard'),
  ('dashboard.delete', 'Delete on dashboard'),

  ('pos.view',   'Open New Sale'),
  ('pos.create', 'Create sales'),
  ('pos.edit',   'Edit sales'),
  ('pos.delete', 'Delete sales'),

  ('customers.view',   'See customers'),
  ('customers.create', 'Create customers'),
  ('customers.edit',   'Edit customers'),
  ('customers.delete', 'Delete customers'),

  ('inventory.view',   'See inventory'),
  ('inventory.create', 'Create products'),
  ('inventory.edit',   'Edit products'),
  ('inventory.delete', 'Delete products'),

  ('lab.view',   'See lab orders'),
  ('lab.create', 'Create lab orders'),
  ('lab.edit',   'Update lab status'),
  ('lab.delete', 'Delete lab orders'),

  ('history.view',   'See sales history'),
  ('history.create', 'Create in history'),
  ('history.edit',   'Edit past orders'),
  ('history.delete', 'Delete history records'),

  ('reports.view',   'See reports'),
  ('reports.create', 'Create in reports'),
  ('reports.edit',   'Edit in reports'),
  ('reports.delete', 'Delete in reports'),

  ('suppliers.view',   'See suppliers'),
  ('suppliers.create', 'Create suppliers/shipments'),
  ('suppliers.edit',   'Edit suppliers/shipments'),
  ('suppliers.delete', 'Delete suppliers/shipments'),

  ('notes.view',   'See notes'),
  ('notes.create', 'Write notes'),
  ('notes.edit',   'Edit notes'),
  ('notes.delete', 'Delete notes'),

  ('staff.view',   'See staff'),
  ('staff.create', 'Add staff'),
  ('staff.edit',   'Change roles & access'),
  ('staff.delete', 'Deactivate staff'),

  ('settings.view',   'See settings'),
  ('settings.create', 'Change settings'),
  ('settings.edit',   'Change settings'),
  ('settings.delete', 'Reset settings')
on conflict (code) do nothing;

-- ---------- 3) initial grants ----------
-- Privileged roles: everything, always re-synced.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where lower(r.name) in ('admin', 'owner')
on conflict (role_id, permission_id) do nothing;

-- One-time safety net: every other EXISTING role that has NO configuration yet
-- gets everything, so enabling this panel never locks anyone out. Once an
-- admin starts configuring a role, only what they tick applies.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where lower(r.name) not in ('admin', 'owner')
  and not exists (select 1 from public.role_permissions rp where rp.role_id = r.id)
on conflict (role_id, permission_id) do nothing;

-- ---------- 5) RLS (same model as 001) ----------
do $$
declare
  t text;
  tables text[] := array[
    'permissions',
    'role_permissions',
    'user_permissions',
    'notes'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists lensy_authenticated_all on public.%I;', t);
    execute format($p$
      create policy lensy_authenticated_all on public.%I
        for all
        to authenticated
        using (true)
        with check (true);
    $p$, t);
    raise notice 'secured table: %', t;
  end loop;
end $$;
