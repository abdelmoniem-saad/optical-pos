-- LensyPOS — Phase 2 security baseline
-- =====================================
-- Enables Row-Level Security on every application table and grants full
-- access to signed-in (authenticated) users only. This is what makes the
-- browser-shipped anon key safe: with RLS on and no anon policy, the anon
-- role can read/write NOTHING.
--
-- Model: single-shop POS where every logged-in staff member is trusted.
-- "authenticated can do everything; anon can do nothing." Granular,
-- role-based policies (e.g. only managers can delete sales) can be layered
-- on later without changing the app.
--
-- Safe to run multiple times (idempotent).
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste -> Run.

do $$
declare
  t text;
  tables text[] := array[
    'customers',
    'inventory',
    'sales',
    'sale_items',
    'order_examinations',
    'prescriptions',
    'stock_movements',
    'users',
    'settings',
    'permissions',
    'role_permissions',
    'user_permissions',
    -- metadata / lookup tables accessed generically by the app
    'roles',
    'lens_types',
    'frame_types',
    'frame_colors',
    'suppliers',
    'warehouses'
  ];
begin
  foreach t in array tables loop
    -- Skip tables that don't exist in this project rather than aborting.
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security;', t);
    -- Force RLS so even the table owner is subject to policies.
    execute format('alter table public.%I force row level security;', t);

    -- Replace any prior copy of our policy so this stays idempotent.
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

-- Verify: every public table should now show rowsecurity = true.
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;
