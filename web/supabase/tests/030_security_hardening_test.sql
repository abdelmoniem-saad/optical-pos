-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (section 6, security hardening). The live project's security
-- advisor reported, and an anonymous probe with the public key confirmed:
--   S1  link_staff_ids() - SECURITY DEFINER, executable by anyone, able to
--       re-point an unlinked staff row to a stranger's sign-up. Dropped.
--       (Replaces 015_link_staff_ids_test.sql, which tested the repair itself.)
--   S2  staff_id_problems - an owner-rights view over auth.users that anon
--       could read. Dropped.
--   S3  contact_lens_types - no RLS and ALL granted to anon/authenticated.
--   S4  seven functions without a fixed search_path.
-- S5/S6 are the regression net: no table in public without RLS, no view in
-- public that runs with its owner's rights, no function without a pinned
-- search_path - so the next object created the old way turns this gate red
-- instead of waiting for the advisor.
begin;
create extension if not exists pgtap;
select plan(14);

-- ===== S1 / S2: the takeover function and the leaking view are gone =======
select hasnt_function('public', 'link_staff_ids',
  'S1 link_staff_ids() no longer exists (anyone could call it)');
select hasnt_view('public', 'staff_id_problems',
  'S2 staff_id_problems no longer exists (anon could read it)');

-- ===== S3: contact_lens_types is closed =====================================
select ok((select relrowsecurity from pg_class where oid = 'public.contact_lens_types'::regclass),
  'S3a contact_lens_types has row level security on');
select ok(not has_table_privilege('anon', 'public.contact_lens_types', 'select')
          and not has_table_privilege('anon', 'public.contact_lens_types', 'insert')
          and not has_table_privilege('anon', 'public.contact_lens_types', 'delete'),
  'S3b anon can neither read, insert nor delete contact_lens_types');
select ok(not has_table_privilege('authenticated', 'public.contact_lens_types', 'select')
          and not has_table_privilege('authenticated', 'public.contact_lens_types', 'insert')
          and not has_table_privilege('authenticated', 'public.contact_lens_types', 'update')
          and not has_table_privilege('authenticated', 'public.contact_lens_types', 'delete'),
  'S3c authenticated has no privilege on contact_lens_types either (no store_id: any row would be every store''s)');

set local role authenticated;
select throws_ok($$ select count(*) from public.contact_lens_types $$, '42501', null,
  'S3d a signed-in read of contact_lens_types is refused');
select throws_ok($$ insert into public.contact_lens_types (name) values ('x') $$, '42501', null,
  'S3e a signed-in insert into contact_lens_types is refused');
reset role;

-- ===== S4: the seven functions pin search_path ===============================
create function pg_temp._path(p regprocedure) returns boolean language sql stable as $$
  select exists (select 1 from pg_proc f, unnest(coalesce(f.proconfig, '{}')) c
                  where f.oid = p and c = 'search_path=public')
$$;
select ok(pg_temp._path('public.auth_uid()'), 'S4a auth_uid pins search_path');
select ok(pg_temp._path('public.guard_sale_money()')
          and pg_temp._path('public.sync_sale_amount_paid()'),
  'S4b the sale money triggers pin search_path');
select ok(pg_temp._path('public.sync_stock_qty()')
          and pg_temp._path('public.normalise_movement_kind()'),
  'S4c the stock movement triggers pin search_path');
select ok(pg_temp._path('public.lab_status_stamp()')
          and pg_temp._path('public.assert_versions_recorded(text[])'),
  'S4d lab_status_stamp and assert_versions_recorded pin search_path');

-- ===== S5 / S6: nothing new slips in the old way ============================
-- Extension members (pgtap here) are not ours and are excluded.
select is((select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                 and d.deptype = 'e')),
  '', 'S5a every table in public has row level security on');
select is((select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('v', 'm')
              and not coalesce((select o.option_value::boolean
                                  from pg_options_to_table(c.reloptions) o
                                 where o.option_name = 'security_invoker'), false)
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                 and d.deptype = 'e')),
  '', 'S5b no view in public runs with its owner''s rights (it would ignore RLS)');
select is((select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind in ('f', 'p')
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                               where c like 'search_path=%')
              and not exists (select 1 from pg_depend d
                               where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                                 and d.deptype = 'e')),
  '', 'S6 every function in public pins its search_path');

rollback;
