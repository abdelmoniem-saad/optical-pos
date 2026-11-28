-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 031 gate (offline-v2 Phase 0b).
--
-- U   SKU and lens/frame type and colour names are unique PER STORE: two
--     stores may share one, the same store may not, and several products may
--     have no SKU. The global constraints are gone; the per-store indexes
--     exist.
-- ST  settings gains (store_id, key); the global key 031 kept for cached apps
--     is gone once 032 runs (ST1, edited with 032); and a signed-in upsert
--     on (store_id, key) updates the existing row instead of adding one.
-- R   referenced_image_paths pages a store's keep-list to the end past the
--     1,000-row cap that cut the old one short, includes a path in the
--     store's folder referenced by another store's sale, ignores blanks,
--     caps a page at 1,000 and refuses anyone but a platform admin.
-- SL  the staff limit counts active staff (create-user), so switching someone
--     back ON at the limit is refused, and allowed once a seat is free.
begin;
create extension if not exists pgtap;
select plan(24);

-- ===== fixtures ============================================================
create function s_a() returns uuid language sql stable as $$ select id from public.stores order by created_at limit 1 $$;
insert into public.stores (id, name) values ('31000000-0000-4000-8000-0000000000b0', 'Store B31') on conflict (id) do nothing;
create function s_b() returns uuid language sql stable as $$ select '31000000-0000-4000-8000-0000000000b0'::uuid $$;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (s_b(), 'STORE-B31', 'pro', null) on conflict (store_id) do nothing;

insert into public.roles (id, name, store_id) values ('31000000-0000-4000-8000-0000000000a1', 'Settings31', s_a());
insert into public.role_permissions (role_id, permission_id)
select '31000000-0000-4000-8000-0000000000a1', p.id from public.permissions p
 where p.code in ('settings.view', 'settings.edit');
insert into auth.users (id, email) values
  ('31000000-0000-4000-8000-0000000000a2', 'set31@t'),
  ('31000000-0000-4000-8000-0000000000c2', 'plat31@t');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('31000000-0000-4000-8000-0000000000a2', 'set_a31', '-', s_a(), '31000000-0000-4000-8000-0000000000a1', true);
insert into public.platform_admins (auth_uid) values ('31000000-0000-4000-8000-0000000000c2');

create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p)::text, true);
end $$;

-- ===== U: per-store uniqueness =============================================
select is((select count(*)::int
             from pg_constraint c
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'u' and array_length(c.conkey, 1) = 1
              and (c.conrelid, a.attname) in (('public.inventory'::regclass, 'sku'),
                                              ('public.lens_types'::regclass, 'name'),
                                              ('public.frame_types'::regclass, 'name'),
                                              ('public.frame_colors'::regclass, 'name'))),
  0, 'U1 no global unique constraint is left on sku or the three catalog names');
select is((select count(*)::int from pg_indexes
            where schemaname = 'public' and indexname in
              ('inventory_store_sku_key', 'lens_types_store_name_key',
               'frame_types_store_name_key', 'frame_colors_store_name_key',
               'settings_store_key_key')),
  5, 'U2 the five per-store unique indexes exist');

insert into public.inventory (name, sku, store_id) values ('Frame A31', 'SKU31', s_a());
select lives_ok($$ insert into public.inventory (name, sku, store_id) values ('Frame B31', 'SKU31', s_b()) $$,
  'U3 two stores may use the same SKU');
select throws_ok($$ insert into public.inventory (name, sku, store_id) values ('Frame A31 again', 'SKU31', s_a()) $$,
  '23505', null, 'U4 one store may not use a SKU twice');
select lives_ok($$ insert into public.inventory (name, sku, store_id) values
  ('No sku 1', null, s_a()), ('No sku 2', null, s_a()) $$,
  'U5 several products of one store may have no SKU');

insert into public.lens_types (name, store_id) values ('Lens31', s_a());
select lives_ok($$ insert into public.lens_types (name, store_id) values ('Lens31', s_b()) $$,
  'U6 two stores may name a lens type the same');
select throws_ok($$ insert into public.lens_types (name, store_id) values ('Lens31', s_a()) $$,
  '23505', null, 'U7 one store may not repeat a lens type name');
insert into public.frame_types (name, store_id) values ('Type31', s_a());
select lives_ok($$ insert into public.frame_types (name, store_id) values ('Type31', s_b()) $$,
  'U8 two stores may name a frame type the same');
select throws_ok($$ insert into public.frame_types (name, store_id) values ('Type31', s_a()) $$,
  '23505', null, 'U9 one store may not repeat a frame type name');
insert into public.frame_colors (name, store_id) values ('Colour31', s_a());
select lives_ok($$ insert into public.frame_colors (name, store_id) values ('Colour31', s_b()) $$,
  'U10 two stores may name a frame colour the same');
select throws_ok($$ insert into public.frame_colors (name, store_id) values ('Colour31', s_a()) $$,
  '23505', null, 'U11 one store may not repeat a frame colour name');

-- ===== ST: settings ========================================================
-- 031 kept settings_key_key for cached apps that still upserted on (key);
-- 032 drops it (the gates run after every migration), so this now pins that
-- the global key is gone and only the per-store key from U2 remains.
select ok(not exists (select 1 from pg_constraint
                       where conrelid = 'public.settings'::regclass and contype = 'u'
                         and conname = 'settings_key_key'),
  'ST1 the global settings key kept by 031 is gone once 032 is applied');

set role authenticated; select _as('31000000-0000-4000-8000-0000000000a2');
insert into public.settings (key, value) values ('k031', 'one')
  on conflict (store_id, key) do update set value = excluded.value;
insert into public.settings (key, value) values ('k031', 'two')
  on conflict (store_id, key) do update set value = excluded.value;
reset role;
select is((select value from public.settings where key = 'k031' and store_id = s_a()), 'two',
  'ST2 a signed-in upsert on (store_id, key) updates the setting (store filled by the tenant trigger)');
select is((select count(*)::int from public.settings where key = 'k031'), 1,
  'ST3 ...and keeps one row for it');

-- ===== R: referenced_image_paths ===========================================
-- 1,500 sales in store B with a prescription photo, the first 300 also with a
-- frame photo: 1,800 paths, so the keep-list needs two pages of 1,000.
insert into public.sales (invoice_no, store_id, total_amount, discount, net_amount,
                          amount_paid, order_date, lab_status, rx_image_path, frame_image_path)
select 'R31-' || lpad(g::text, 5, '0'), s_b(), 0, 0, 0, 0, now(), null,
       'store/' || s_b() || '/orders/rx-' || lpad(g::text, 5, '0') || '.jpg',
       case when g <= 300 then 'store/' || s_b() || '/orders/fr-' || lpad(g::text, 5, '0') || '.jpg' end
  from generate_series(1, 1500) g;
-- A sale of store A pointing into store B's folder, and blank paths.
insert into public.sales (invoice_no, store_id, total_amount, discount, net_amount,
                          amount_paid, order_date, lab_status, rx_image_path, frame_image_path)
values ('R31-A', s_a(), 0, 0, 0, 0, now(), null, 'store/' || s_b() || '/orders/shared.jpg', '  '),
       ('R31-A2', s_b(), 0, 0, 0, 0, now(), null, '', null);

create table _walk (n int, path text);
grant all on _walk to authenticated;
create function _walk_all(p_store uuid) returns int language plpgsql as $$
declare
  v_after text := null;
  v_page int := 0;
  v_got int;
begin
  loop
    v_page := v_page + 1;
    insert into _walk select v_page, r.path from public.referenced_image_paths(p_store, v_after, 1000) r;
    get diagnostics v_got = row_count;
    exit when v_got < 1000;
    select max(path collate "C") into v_after from _walk where n = v_page;
  end loop;
  return v_page;
end $$;

set role authenticated; select _as('31000000-0000-4000-8000-0000000000a2');
select throws_ok($$ select * from public.referenced_image_paths(s_b(), null, 10) $$,
  '42501', null, 'R1 a store user (not a platform admin) is refused');
reset role;

set role authenticated; select _as('31000000-0000-4000-8000-0000000000c2');
select is(_walk_all(s_b()), 2, 'R2 the keep-list takes two pages past the 1,000-row cap');
select is((select count(*)::int from public.referenced_image_paths(s_b(), null, 5000)), 1000,
  'R3 a page never exceeds 1,000 rows');
reset role;

select is((select count(distinct path)::int from _walk), 1801,
  'R4 every referenced path came back once: 1,500 rx + 300 frame + the shared one');
select is((select count(*)::int from _walk), 1801, 'R5 ...with no path repeated across pages');
select ok(exists (select 1 from _walk where path = 'store/' || s_b() || '/orders/shared.jpg'),
  'R6 a path in the store''s folder referenced by another store''s sale is kept');
select ok(not exists (select 1 from _walk where btrim(path) = ''),
  'R7 blank paths are not returned');

-- ===== SL: switching staff on respects the limit ===========================
-- Store B allows 2 staff. Active: the manager and X. Y is switched off.
update public.store_licenses set max_staff = 2 where store_id = s_b();
insert into public.roles (id, name, store_id) values
  ('31000000-0000-4000-8000-0000000000b1', 'Manager31', s_b()),
  ('31000000-0000-4000-8000-0000000000b3', 'Seller31', s_b());
insert into public.role_permissions (role_id, permission_id)
select '31000000-0000-4000-8000-0000000000b1', p.id from public.permissions p
 where p.code in ('staff.view', 'staff.edit', 'staff.delete');
insert into auth.users (id, email) values
  ('31000000-0000-4000-8000-0000000000b2', 'mgr31@t'),
  ('31000000-0000-4000-8000-0000000000b4', 'x31@t'),
  ('31000000-0000-4000-8000-0000000000b5', 'y31@t');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('31000000-0000-4000-8000-0000000000b2', 'mgr_b31', '-', s_b(), '31000000-0000-4000-8000-0000000000b1', true),
  ('31000000-0000-4000-8000-0000000000b4', 'x_b31', '-', s_b(), '31000000-0000-4000-8000-0000000000b3', true),
  ('31000000-0000-4000-8000-0000000000b5', 'y_b31', '-', s_b(), '31000000-0000-4000-8000-0000000000b3', false);

set role authenticated; select _as('31000000-0000-4000-8000-0000000000b2');
select throws_ok($$ select public.set_staff_access('31000000-0000-4000-8000-0000000000b5',
                    '31000000-0000-4000-8000-0000000000b3', true) $$,
  'P0001', 'Staff limit reached (2/2): switch someone off first',
  'SL1 switching a person back on at the staff limit is refused');
select lives_ok($$ select public.set_staff_access('31000000-0000-4000-8000-0000000000b4',
                   '31000000-0000-4000-8000-0000000000b3', true) $$,
  'SL2 saving an already-active person at the limit takes no new seat and is allowed');
select public.set_staff_access('31000000-0000-4000-8000-0000000000b4', '31000000-0000-4000-8000-0000000000b3', false);
select lives_ok($$ select public.set_staff_access('31000000-0000-4000-8000-0000000000b5',
                   '31000000-0000-4000-8000-0000000000b3', true) $$,
  'SL3 once someone is switched off, the freed seat can be used');
reset role;

rollback;
