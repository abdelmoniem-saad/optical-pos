-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 033 gate (offline-v2 Phase 1, docs/offline-v2/design.md section 4.3).
-- Store A is the OLDEST store (so legacy root photos are its) and is put on
-- a register; B is an ordinary store throughout.
--
-- V   shape: the two store columns, the five register tables (RLS forced, no
--     client privilege), the guard on exactly the 25 tables and last among
--     their BEFORE triggers, every new function's grants, the index, stamp 33.
-- D   dark: an ordinary store's my_permissions is 029's answer plus
--     read_only false; register_store_id()/register_status() are NULL; a
--     login with no staff row and no register gets no store at all; the
--     oldest store still writes a legacy root photo.
-- PU  usernames: the precheck lists same-store case/space duplicates and
--     stops; cross-store cloud logins 'Ahmed33'/'ahmed33' (allowed before)
--     do not stop it; the per-store and cloud keys replace users_username_key.
-- O   owners: set_store_owner is the vendor's and checks the login; the
--     backfill sets an owner only for exactly one ACTIVE admin CLOUD login
--     (platform admins, inactive admins and register-local admins excluded);
--     register_only never flips by a direct write, and no direct write names
--     an owner, on any store.
-- I   _register_install: service role only, owner-claimed, fresh login.
-- G   with A register_only, refused 42501 'read-only: ...': a platform admin
--     inserting a customer or a role grant, updating A's store row, moving a
--     customer to B, or setting the lensy.* GUCs itself; the owner calling a
--     definer RPC with lensy.register_admin set; the owner calling every
--     write RPC (create/update/void/refund/collect, lab status, exams,
--     close, receive, add item, the four staff RPCs), a direct settings
--     upsert or a customers insert with store_id omitted; a service-role
--     users insert; postgres (a migration) without the bypass, or with the
--     GUC but no token, or with the wrong kind of token. Nothing moved.
-- W   still working: B's checkout, note_seen in A, a platform admin's
--     store_licenses update in A, reading A.
-- P   the phone: my_permissions read_only/is_owner, view codes only, is_admin
--     false; B's staff, B's owner and the vendor get 029's answer unchanged.
-- IG  the ingest gate: a staff session setting lensy.ingest/actor/event_at
--     gets the normal audit actor and lab stamp; the register's path (owner
--     context + register JWT + ingest token) writes A with the op's actor and
--     time; without the token, or with a non-register JWT, or in a client
--     session, it is not the ingest path.
-- ST  storage: the register inserts in store/<A>/orders only, cannot update
--     or delete there, may delete its drop/ files; the owner cannot write
--     A's photos (legacy root and drop/ included, A being the oldest store)
--     but still reads them; platform admins cannot delete or rename them;
--     drop/ is the register's; the register reads its store folder only
--     inside its setup window (setup not done, snapshot_until not passed).
-- T   QR tickets: register only, single use, expire, per store.
-- Q   a quarantined register login is nobody: no store, no ticket, no upload.
-- CM  owner_deactivate_staff: queues one command; protected targets, non-
--     owners, another store's owner and the register JWT are refused.
-- RS  register_status / register_flags: store members, summaries only.
-- BY  set_store_owner on register_only A works (and revokes); the bypass is
--     not left behind; a re-claim is epoch 2 with last_seq kept.
-- RV  revoke_register: owner or platform admin only, idempotent.
-- RL  release_register (interpretation, see 033's header).
-- CV  _register_convert_staff / _register_mark_local on register_only A.
-- EM  end_register_mode: who may, pending/force, counter (raised to the PC's
--     numbers, never lowered), every register-local login off and renamed,
--     then a cloud 'ahmed' fits.
-- UN  per-store names: register-local 'ahmed' in two stores; a cloud 'ahmed'
--     reused, and a same-store 'Ahmed ' -> 23505.
-- OW  deleting an owner's login.
begin;
create extension if not exists pgtap;
select plan(189);

-- ===== fixtures ============================================================
create function u(p text) returns uuid language sql immutable as $$
  select ('33000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function s_a() returns uuid language sql immutable as $$ select u('a0') $$;
create function s_b() returns uuid language sql immutable as $$ select u('b0') $$;
create function s_c() returns uuid language sql immutable as $$ select u('c0') $$;
create function s_d() returns uuid language sql immutable as $$ select u('d0') $$;
create function s_e() returns uuid language sql immutable as $$ select u('e0') $$;
create function s_f() returns uuid language sql immutable as $$ select u('f0') $$;
create function s_g() returns uuid language sql immutable as $$ select u('fa') $$;

create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claims', case when p is null then '{}' else json_build_object('sub', p)::text end, true);
end $$;
create function _ingest(p_ingest text, p_store uuid, p_actor uuid, p_at text) returns void language plpgsql as $$
begin
  perform set_config('lensy.ingest', coalesce(p_ingest, ''), true);
  perform set_config('lensy.store', coalesce(p_store::text, ''), true);
  perform set_config('lensy.actor', coalesce(p_actor::text, ''), true);
  perform set_config('lensy.event_at', coalesce(p_at, ''), true);
end $$;
create function _admin_guc(p_store uuid) returns void language plpgsql as $$
begin
  perform set_config('lensy.register_admin', coalesce(p_store::text, ''), true);
end $$;
-- What only definer code can do (postgres here): open or close a bypass token.
create function _token(p_store uuid, p_kind text, p_open boolean) returns void language plpgsql as $$
begin
  perform public._register_bypass(p_store, p_kind, p_open);
end $$;
-- Rows a statement touched (UPDATE/DELETE under RLS refuse by touching none).
create function _n(p_sql text) returns int language plpgsql as $$
declare v int;
begin
  execute p_sql;
  get diagnostics v = row_count;
  return v;
end $$;

create table _r (k text primary key, j jsonb);
grant all on _r to authenticated, service_role;

-- Supabase gives these out of the box; the shim does not. Test-only, rolled back.
grant select, insert, update, delete on storage.objects to authenticated;
grant insert on public.users to service_role;
alter role service_role bypassrls;

insert into public.stores (id, name, created_at) values
  ('33000000-0000-4000-8000-0000000000a0', 'Store A33', '2000-01-01 00:00:00+00'),
  ('33000000-0000-4000-8000-0000000000b0', 'Store B33', now()),
  ('33000000-0000-4000-8000-0000000000c0', 'Store C33', now()),
  ('33000000-0000-4000-8000-0000000000d0', 'Store D33', now()),
  ('33000000-0000-4000-8000-0000000000e0', 'Store E33', now()),
  ('33000000-0000-4000-8000-0000000000f0', 'Store F33', now()),
  ('33000000-0000-4000-8000-0000000000fa', 'Store G33', now());
insert into public.store_licenses (store_id, license_key, plan, expires_at) values
  (s_a(), 'STORE-A33', 'pro', null), (s_b(), 'STORE-B33', 'pro', null),
  (s_c(), 'STORE-C33', 'pro', null), (s_d(), 'STORE-D33', 'pro', null);

-- Roles. A: Admin, Cashier33. B: Admin, Seller33. C, D, F, G: Admin.
insert into public.roles (id, name, store_id) values
  ('33000000-0000-4000-8000-0000000000a1', 'Admin',     s_a()),
  ('33000000-0000-4000-8000-0000000000a2', 'Cashier33', s_a()),
  ('33000000-0000-4000-8000-0000000000b1', 'Admin',     s_b()),
  ('33000000-0000-4000-8000-0000000000b2', 'Seller33',  s_b()),
  ('33000000-0000-4000-8000-0000000000c1', 'Admin',     s_c()),
  ('33000000-0000-4000-8000-0000000000d1', 'Admin',     s_d()),
  ('33000000-0000-4000-8000-0000000000f4', 'Admin',     s_f()),
  ('33000000-0000-4000-8000-0000000000fb', 'Admin',     s_g());
insert into public.role_permissions (role_id, permission_id)
select u('a2'), p.id from public.permissions p
 where p.code in ('pos.view', 'pos.create', 'history.view', 'notes.view');
insert into public.role_permissions (role_id, permission_id)
select u('b2'), p.id from public.permissions p
 where p.code in ('pos.view', 'pos.create', 'lab.view', 'lab.edit', 'history.view');

-- People. A: a1 owner-to-be and a2 second admin (cloud), a3 'ahmed' and a6
-- 'mona' (register-local, a6 off), a4 cashier (cloud), a5 legacy row with no
-- login. B: b1 admin, b2 seller. C: c1 admin, and p2 a vendor account that
-- also holds a C admin row. D: two admins. F: an admin and a switched-off
-- admin (both cloud). G: a cloud admin and an active register-local admin
-- whose old login still exists (left from register mode). p1 vendor, r1/r3
-- A's register logins, r2 C's, x1 a public sign-up with nothing else.
insert into auth.users (id, email) values
  (u('11'), 'a1@t33'), (u('12'), 'a2@t33'), (u('14'), 'a4@t33'),
  (u('21'), 'b1@t33'), (u('22'), 'b2@t33'), (u('31'), 'c1@t33'), (u('32'), 'p2@t33'),
  (u('41'), 'd1@t33'), (u('42'), 'd2@t33'), (u('61'), 'p1@t33'),
  (u('f5'), 'f1@t33'), (u('f6'), 'f2@t33'), (u('fc'), 'g1@t33'), (u('fd'), 'g2@t33'),
  (u('71'), 'register.a.1@t33'), (u('72'), 'register.c.1@t33'), (u('73'), 'register.a.2@t33'),
  (u('81'), 'x1@t33');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  (u('11'), 'owner_a33',  'supabase-auth',  s_a(), u('a1'), true),
  (u('12'), 'admin2_a33', 'supabase-auth',  s_a(), u('a1'), true),
  (u('13'), 'ahmed',      'register-local', s_a(), u('a2'), true),
  (u('14'), 'cashier_a33','supabase-auth',  s_a(), u('a2'), true),
  (u('15'), 'legacy_a33', '-',              s_a(), u('a2'), true),
  (u('16'), 'mona',       'register-local', s_a(), u('a2'), false),
  (u('21'), 'owner_b33',  'supabase-auth',  s_b(), u('b1'), true),
  (u('22'), 'seller_b33', 'supabase-auth',  s_b(), u('b2'), true),
  (u('31'), 'owner_c33',  'supabase-auth',  s_c(), u('c1'), true),
  (u('32'), 'vendor_c33', 'supabase-auth',  s_c(), u('c1'), true),
  (u('41'), 'admin1_d33', 'supabase-auth',  s_d(), u('d1'), true),
  (u('42'), 'admin2_d33', 'supabase-auth',  s_d(), u('d1'), true),
  (u('f5'), 'owner_f33',  'supabase-auth',  s_f(), u('f4'), true),
  (u('f6'), 'oldadmin_f33','supabase-auth', s_f(), u('f4'), false),
  (u('fc'), 'owner_g33',  'supabase-auth',  s_g(), u('fb'), true),
  (u('fd'), 'localadmin_g33','register-local', s_g(), u('fb'), true);
insert into public.platform_admins (auth_uid) values (u('61')), (u('32'));

-- Store A's business, written while it is still an ordinary store.
insert into public.customers (id, name, phone, store_id) values (u('91'), 'Customer A33', '01000033091', s_a());
insert into public.inventory (id, name, category, sale_price, cost_price, store_id) values
  (u('92'), 'Frame A33', 'Frame', 100, 50, s_a()),
  (u('93'), 'Frame B33', 'Frame', 50, 20, s_b());
insert into public.stock_movements (product_id, qty, type, store_id) values
  (u('92'), 10, 'initial', s_a()), (u('93'), 10, 'initial', s_b());
insert into public.sales (id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid,
                          order_date, lab_status, kind, store_id) values
  (u('e1'), '000150', u('91'),   0, 0,   0, 0, now(), 'In Lab', 'sale', s_a()),
  (u('e2'), '000151', u('91'), 100, 0, 100, 0, now(), null,     'sale', s_a()),
  (u('e3'), '000152', u('91'), 100, 0, 100, 0, now(), null,     'sale', s_a()),
  (u('e4'), 'B33-1',  null,      0, 0,   0, 0, now(), 'In Lab', 'sale', s_b());
insert into public.order_examinations (sale_id, store_id, exam_type) values (u('e1'), s_a(), 'distance');
insert into public.sale_items (sale_id, store_id, product_id, name, qty, unit_price, total_price) values
  (u('e2'), s_a(), u('92'), 'Frame A33', 1, 100, 100);
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id) values
  (u('e2'), 100, 'cash', 'payment', now(), s_a());
insert into public.purchases (id, supplier_id, total_amount, amount_paid, store_id) values (u('f1'), null, 100, 0, s_a());
insert into public.purchase_items (id, purchase_id, product_id, qty, unit_cost, total_cost, store_id) values
  (u('f2'), u('f1'), u('92'), 2, 50, 100, s_a());
insert into public.notes (id, body, user_id, created_by, store_id) values (u('f3'), 'Team note A33', null, u('11'), s_a());
insert into public.invoice_counter (store_id, prefix, next_val) values (s_a(), '', 5);
-- C: a counter already past its highest invoice (500 > 000200 + 1), for EM11.
insert into public.sales (id, invoice_no, customer_id, total_amount, discount, net_amount, amount_paid,
                          order_date, lab_status, kind, store_id) values
  (u('e5'), '000200', null, 0, 0, 0, 0, now(), null, 'sale', s_c());
insert into public.invoice_counter (store_id, prefix, next_val) values (s_c(), '', 500);

-- 029's my_permissions, kept as the oracle for "unchanged".
create function _mp029() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_admin', coalesce(public.is_store_admin(),false),
    'active', public.is_platform_admin() or exists(select 1 from public.users where id=auth.uid() and is_active is true),
    'assigned', public.is_platform_admin() or public.auth_store_id() is not null,
    'codes', coalesce((select jsonb_agg(c) from unnest(public.supported_permissions()) c where public.resolve_can(c)), '[]'::jsonb))
$$;

-- What store A holds, to prove a refused write left nothing behind.
create function _a_counts() returns text language sql stable as $$
  select concat_ws(' | ',
    (select count(*) from public.customers where store_id = s_a()),
    (select count(*) from public.sales where store_id = s_a()),
    (select count(*) from public.sale_items where store_id = s_a()),
    (select count(*) from public.order_examinations where store_id = s_a()),
    (select count(*) || ':' || coalesce(sum(amount), 0) from public.sale_payments where store_id = s_a()),
    (select count(*) || ':' || coalesce(sum(qty), 0) from public.stock_movements where store_id = s_a()),
    (select count(*) from public.inventory where store_id = s_a()),
    (select string_agg(prefix || '=' || next_val, ';') from public.invoice_counter where store_id = s_a()),
    (select count(*) from public.shift_closes where store_id = s_a()),
    (select count(*) || ':' || count(*) filter (where is_active) from public.users where store_id = s_a()),
    (select count(*) from public.roles where store_id = s_a()),
    (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.store_id = s_a()),
    (select count(*) from public.user_permissions up join public.users x on x.id = up.user_id where x.store_id = s_a()),
    (select count(*) from public.settings where store_id = s_a()),
    (select count(*) from public.purchase_items where store_id = s_a() and received_at is null),
    (select name from public.stores where id = s_a()),
    (select string_agg(coalesce(lab_status, '-') || '/' || coalesce(voided_at::text, '-'), ';' order by invoice_no)
       from public.sales where store_id = s_a()))
$$;

-- ===== V: shape ============================================================
select ok((select a.attnotnull and a.atttypid = 'boolean'::regtype and pg_get_expr(d.adbin, d.adrelid) = 'false'
             from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = 'public.stores'::regclass and a.attname = 'register_only'),
  'V1 stores.register_only is boolean NOT NULL DEFAULT false');
select ok(exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                   where c.conrelid = 'public.stores'::regclass and c.contype = 'f' and a.attname = 'owner_uid'
                     and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'n'),
  'V2 stores.owner_uid references auth.users ON DELETE SET NULL');
select ok((select count(*) from public.stores where register_only) = 0
          and (select count(*) from public.store_registers) = 0
          and (select count(*) from public.register_ops) = 0
          and (select count(*) from public.register_commands) = 0
          and (select count(*) from public.register_bypass) = 0,
  'V3 dark: no store is register_only and no register, op, command or bypass token exists (the backfill closed its own)');
select is((select string_agg(c.relname, ',' order by c.relname) from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relrowsecurity and c.relforcerowsecurity
              and c.relname in ('store_registers', 'register_ops', 'register_commands', 'register_photo_tickets',
                                'register_bypass')),
  'register_bypass,register_commands,register_ops,register_photo_tickets,store_registers',
  'V4 the five register tables have row level security on and forced');
select is((select count(*)::int
             from unnest(array['public.store_registers', 'public.register_ops', 'public.register_commands',
                               'public.register_photo_tickets', 'public.register_bypass']) t(n),
                  unnest(array['anon', 'authenticated', 'service_role']) r(role),
                  unnest(array['select', 'insert', 'update', 'delete']) p(priv)
            where has_table_privilege(r.role, t.n, p.priv)), 0,
  'V5 no client role (anon, authenticated, service_role) holds any privilege on them');
select is((select string_agg(c.relname, ',' order by c.relname)
             from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where t.tgname = 'zz_register_only' and not t.tgisinternal
              and c.relnamespace = 'public'::regnamespace and t.tgtype = 31),
  'customers,frame_colors,frame_types,inventory,invoice_counter,lens_types,notes,order_examinations,prescriptions,purchase_items,purchase_payments,purchases,role_permissions,roles,sale_items,sale_payments,sales,settings,shift_closes,stock_movements,stores,suppliers,user_permissions,users,warehouses',
  'V6 zz_register_only is a BEFORE INSERT/UPDATE/DELETE row trigger on exactly the 25 tables (not note_seen, store_licenses, platform_admins, permissions, audit_log, register tables)');
select is((select count(*)::int from pg_trigger t
            where t.tgrelid in (select tgrelid from pg_trigger where tgname = 'zz_register_only')
              and not t.tgisinternal and (t.tgtype & 3) = 3 and t.tgname > 'zz_register_only'), 0,
  'V7 it is the last BEFORE row trigger on each table (fires after tenant_fill_store_id and the rest)');
select ok(not (select prosecdef from pg_proc where oid = 'public.guard_register_only()'::regprocedure)
          and (select prosecdef from pg_proc where oid = 'public.store_is_register_only(uuid)'::regprocedure),
  'V8 the guard runs as the caller (its bypass rule reads current_user); the store lookup it calls is a definer');
select is((select coalesce(string_agg(f, ', '), '') from unnest(array[
             'public.my_permissions()', 'public.store_is_register_only(uuid)', 'public.register_store_id()',
             'public.register_snapshot_open()', 'public.storage_write_blocked(text, text)',
             'public.set_store_owner(uuid, uuid)', 'public.revoke_register(uuid)', 'public.release_register(uuid)',
             'public.end_register_mode(uuid, boolean)', 'public.owner_deactivate_staff(uuid)',
             'public.register_status()', 'public.register_flags(integer)', 'public.register_photo_ticket(text, text)',
             'public.register_photo_tickets_open()', 'public.register_photo_fetched(uuid)']) f
            where not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  '', 'V9 the signed-in functions are executable by authenticated and not by anon');
select is((select coalesce(string_agg(f, ', '), '') from unnest(array[
             'public._register_install(uuid, uuid, uuid)', 'public._register_convert_staff(uuid)',
             'public._register_mark_local(uuid, uuid[])', 'public.register_photo_ticket_use(uuid)']) f
            where not has_function_privilege('service_role', f, 'execute')
               or has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  '', 'V10 the setup primitives and the ticket claim are the service role''s only');
select is((select coalesce(string_agg(f, ', '), '') from unnest(array[
             'public.is_cloud_principal(uuid)', 'public._register_username_keys()', 'public._backfill_store_owners()',
             'public.guard_register_only()', 'public.audit_row()', 'public.lab_status_stamp()',
             'public._register_bypass(uuid, text, boolean)', 'public._register_bypass_ok(uuid, text)',
             'public._register_ingest_store()']) f
            where has_function_privilege('service_role', f, 'execute')
               or has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  '', 'V11 the internals are executable by no client role');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'sale_payments'
                     and indexdef like '%(store_id, paid_at)%')
          and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'register_ops_attention_idx'
                         and indexdef like '%WHERE (status <> ''ok''::text)%')
          and exists (select 1 from pg_constraint where conname = 'register_ops_store_op_key'),
  'V12 indexes: sale_payments (store_id, paid_at); register_ops unique (store_id, op_id) and a partial index on non-ok');
select ok(exists (select 1 from public.lensy_schema_versions where version = 33), 'V13 033 stamped itself');

-- ===== D: dark - an ordinary store sees no change ==========================
set role authenticated; select _as(u('22'));
select is(public.my_permissions() - 'read_only' - 'is_owner', _mp029(),
  'D1 a store user''s my_permissions is 029''s answer once the two new fields are set aside');
select ok((public.my_permissions() ->> 'read_only')::boolean = false
          and (public.my_permissions() ->> 'is_owner')::boolean = false
          and public.store_is_register_only(s_b()) = false
          and public.register_store_id() is null
          and public.register_status() is null,
  'D2 ...read_only false, is_owner false; no register: register_store_id() and register_status() are NULL');
select _as(u('61'));
select is(public.my_permissions(), _mp029() || '{"read_only": false, "is_owner": false}'::jsonb,
  'D3 a platform admin''s answer is unchanged too');
select _as(u('81'));
select ok(public.auth_store_id() is null and public.register_store_id() is null,
  'D4 a login with no staff row and no register row (public sign-up) has neither a store nor a register store');
select _as(u('11'));
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('prescriptions', 'rootdark33.jpg') $$,
  'D5 the oldest store (A, still ordinary) writes a legacy root photo as 008 allows');
reset role; select _as(null);

-- ===== PU: the username precheck, replayed on the pre-033 table ============
-- Put users back as 032 left it: the global exact key, no per-store keys.
drop index public.users_store_username_key;
drop index public.users_cloud_username_key;
alter table public.users add constraint users_username_key unique (username);
insert into auth.users (id, email) values
  (u('17'), 'ahmed33a@t33'), (u('23'), 'ahmed33b@t33'), (u('24'), 'bob33@t33'), (u('25'), 'bob33b@t33');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  (u('17'), 'Ahmed33', 'supabase-auth', s_a(), u('a2'), true),   -- cross-store cloud pair:
  (u('23'), 'ahmed33', 'supabase-auth', s_b(), u('b2'), true),   -- legal before 033 and after
  (u('24'), 'Bob33',   'supabase-auth', s_b(), u('b2'), true),   -- same store, differ only in
  (u('25'), 'bob33 ',  'supabase-auth', s_b(), u('b2'), true);   -- case and a trailing space
select throws_like($$ select public._register_username_keys() $$,
  '033 stopped: these usernames differ only in capitals or spaces inside one store%''Bob33'', ''bob33 ''%',
  'PU1 the precheck stops the paste and lists the same-store pair');
delete from public.users where id = u('25');
select lives_ok($$ select public._register_username_keys() $$,
  'PU2 with the pair fixed it applies, though ''Ahmed33'' (A) and ''ahmed33'' (B) are both cloud logins');
select ok(not exists (select 1 from pg_constraint where conrelid = 'public.users'::regclass and contype = 'u'
                         and conname = 'users_username_key')
          and exists (select 1 from pg_indexes where indexname = 'users_store_username_key'
                         and indexdef like '%UNIQUE%(store_id, lower(btrim(username)))%')
          and exists (select 1 from pg_indexes where indexname = 'users_cloud_username_key'
                         and indexdef like '%UNIQUE%(username) WHERE (password_hash IS DISTINCT FROM ''register-local''::text)%')
          and (select count(*) from public.users where id in (u('17'), u('23'))) = 2,
  'PU3 users_username_key is gone; unique (store_id, lower(btrim(username))) and the exact cloud key exist; both logins kept');
delete from public.users where id in (u('17'), u('23'), u('24'));
delete from auth.users where id in (u('17'), u('23'), u('24'), u('25'));

-- ===== O: owners ===========================================================
set role authenticated; select _as(u('11'));
select throws_ok($$ select public.set_store_owner(s_a(), u('11')) $$, '42501', null,
  'O1 a store admin cannot name the owner (the vendor does)');
select _as(u('61'));
select throws_ok($$ select public.set_store_owner(s_a(), u('14')) $$, '22023', null,
  'O2 the owner must be an admin: a cashier login is refused');
select throws_ok($$ select public.set_store_owner(s_a(), u('21')) $$, '22023', null,
  'O3 ...and of THIS store: another store''s admin is refused');
select throws_ok($$ select public.set_store_owner(s_c(), u('32')) $$, '22023', null,
  'O4 ...and not a vendor account, even one holding the store''s admin row');
select lives_ok($$ select public.set_store_owner(s_a(), u('11')) $$, 'O5 the vendor sets A''s owner');
select _as(u('11'));
select ok((public.my_permissions() ->> 'is_owner')::boolean and not (public.my_permissions() ->> 'read_only')::boolean
          and (public.my_permissions() ->> 'is_admin')::boolean,
  'O6 the owner''s my_permissions: is_owner true; A not yet on a register, so read_only false and is_admin true');
reset role; select _as(null);
select is(public._backfill_store_owners(), 4, 'O7 the backfill sets four owners (B, C, F and G)');
select is((select string_agg(s.name || '=' || coalesce(x.username, '-'), ', ' order by s.name)
             from public.stores s left join public.users x on x.id = s.owner_uid
            where s.id in (s_a(), s_b(), s_c(), s_d(), s_e(), s_f(), s_g())),
  'Store A33=owner_a33, Store B33=owner_b33, Store C33=owner_c33, Store D33=-, Store E33=-, Store F33=owner_f33, Store G33=owner_g33',
  'O8 one ACTIVE admin CLOUD login -> owner (B; C without the vendor account; F without its switched-off admin; G without its register-local admin); two (D) or none (E) -> no owner; A kept');
set role authenticated; select _as(u('61'));
select throws_ok($$ update public.stores set register_only = true where id = s_d() $$, '42501',
  'read-only: this shop records on its register PC',
  'O9 a platform admin cannot switch a store to register_only by a direct write');
select throws_ok($$ insert into public.stores (name, register_only) values ('Sneaky33', true) $$, '42501',
  'read-only: this shop records on its register PC',
  'O10 ...nor create a store that is register_only');
select throws_ok($$ update public.stores set owner_uid = u('22') where id = s_b() $$, '42501',
  'a store''s owner is set only with set_store_owner',
  'O11 ...nor name an ordinary store''s owner by a direct write (B''s seller here: set_store_owner would refuse it)');
select throws_ok($$ insert into public.stores (name, owner_uid) values ('Owned33', u('61')) $$, '42501',
  'a store''s owner is set only with set_store_owner',
  'O12 ...nor create a store with an owner already named');
reset role; select _as(null);
select is((select owner_uid from public.stores where id = s_b()), u('21'), 'O13 B''s owner is unchanged');

-- ===== I: installing the register ==========================================
set role service_role;
select throws_ok($$ select public._register_install(s_a(), u('71'), u('12')) $$, '42501', null,
  'I1 only the owner can claim the store''s register');
select throws_ok($$ select public._register_install(s_a(), u('14'), u('11')) $$, '22023', null,
  'I2 the register login cannot be a staff login');
select throws_ok($$ select public._register_install(s_a(), u('61'), u('11')) $$, '22023', null,
  'I3 ...nor a vendor account');
insert into _r select 'install_a1', public._register_install(s_a(), u('71'), u('11'));
insert into _r select 'install_a1_again', public._register_install(s_a(), u('71'), u('11'));
reset role;
select is((select j - 'snapshot_until' from _r where k = 'install_a1'),
  '{"epoch": 1, "last_seq": 0, "previous_uid": null, "max_invoice": 152}'::jsonb,
  'I4 the first claim is epoch 1 at seq 0, and reports A''s highest numeric invoice');
select ok((select register_only from public.stores where id = s_a())
          and (select register_uid = u('71') and epoch = 1 and snapshot_until > now() and revoked_at is null
                 from public.store_registers where store_id = s_a())
          and (select (j ->> 'epoch')::int from _r where k = 'install_a1_again') = 1,
  'I5 A is register_only with r1 on a 24 h setup window; repeating the same claim moves nothing');
set role authenticated; select _as(u('71'));
select ok(public.register_store_id() = s_a() and public.auth_store_id() is null,
  'I6 the register login resolves to A through register_store_id(), and to no staff store');
reset role; select _as(null);

-- ===== G: everything else is refused for A =================================
create table _snap (k text primary key, v text);
insert into _snap values ('a', _a_counts());

set role authenticated; select _as(u('61'));
select throws_ok($$ insert into public.customers (name, phone, store_id) values ('Guard33', '0100', s_a()) $$,
  '42501', 'read-only: this shop records on its register PC', 'G1 a platform admin inserting a customer in A');
select throws_ok($$ insert into public.role_permissions (role_id, permission_id)
                    select u('a2'), p.id from public.permissions p where p.code = 'notes.create' $$,
  '42501', 'read-only: this shop records on its register PC', 'G2 a platform admin granting a permission to A''s role');
select throws_ok($$ update public.stores set name = 'Renamed33' where id = s_a() $$,
  '42501', 'read-only: this shop records on its register PC', 'G3 a platform admin updating A''s store row');
select throws_ok($$ update public.customers set store_id = s_b() where id = u('91') $$,
  '42501', 'read-only: this shop records on its register PC', 'G4 a platform admin moving A''s customer to B');
select _admin_guc(s_a());
select throws_ok($$ insert into public.customers (name, store_id) values ('Bypass33', s_a()) $$,
  '42501', 'read-only: this shop records on its register PC',
  'G5 lensy.register_admin set in an authenticated session is ignored');
select _admin_guc(null);
select _ingest('1', s_a(), u('11'), null);
select throws_ok($$ insert into public.customers (name, store_id) values ('Ingest33', s_a()) $$,
  '42501', 'read-only: this shop records on its register PC',
  'G6 ...and so are the ingest GUCs');
select _ingest(null, null, null, null);

-- Inside any definer RPC current_user IS the functions' owner, so the GUC
-- alone would pass there; the bypass also needs the token no client can write.
select _as(u('11'));
select _admin_guc(s_a());
select throws_ok($$ select public.set_lab_status(u('e1'), 'Received') $$,
  '42501', 'read-only: this shop records on its register PC',
  'G5b the owner with lensy.register_admin set, calling a definer RPC (set_lab_status), is still refused');
select throws_ok($$ select public.add_inventory_item('{"name":"Bypass33","sale_price":10}'::jsonb, 0) $$,
  '42501', 'read-only: this shop records on its register PC',
  'G5c ...and add_inventory_item');
select _admin_guc(null);

select throws_ok($$ select public.create_sale_order('{"total_amount":0,"discount":0,"net_amount":0,"amount_paid":0}'::jsonb,
                      '[]'::jsonb, '[{"exam_type":"distance"}]'::jsonb, '[]'::jsonb, null) $$,
  '42501', 'read-only: this shop records on its register PC', 'G7 the owner: create_sale_order');
select throws_ok($$ select public.update_sale_order(u('e1'), '{"total_amount":0,"discount":0,"net_amount":0}'::jsonb,
                      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) $$,
  '42501', 'read-only: this shop records on its register PC', 'G8 the owner: update_sale_order (re-checkout)');
select throws_ok($$ select public.void_sale(u('e2'), 'gate', true) $$,
  '42501', 'read-only: this shop records on its register PC', 'G9 the owner: void_sale');
select throws_ok($$ select public.refund_sale(u('e2'), 10, 'cash', 'gate') $$,
  '42501', 'read-only: this shop records on its register PC', 'G10 the owner: refund_sale');
select throws_ok($$ select public.collect_sale_payment(u('e3'), '[{"amount":10,"method":"cash"}]'::jsonb) $$,
  '42501', 'read-only: this shop records on its register PC', 'G11 the owner: collect_sale_payment');
select throws_ok($$ select public.set_lab_status(u('e1'), 'Ready') $$,
  '42501', 'read-only: this shop records on its register PC', 'G12 the owner: set_lab_status');
select throws_ok($$ select public.replace_order_examinations(u('e1'), '[{"exam_type":"near"}]'::jsonb) $$,
  '42501', 'read-only: this shop records on its register PC', 'G13 the owner: replace_order_examinations');
select throws_ok($$ select public.close_shift('2026-01-01 00:00:00+00', '2026-01-02 00:00:00+00', 0, 'gate') $$,
  '42501', 'read-only: this shop records on its register PC', 'G14 the owner: close_shift');
select throws_ok($$ select public.receive_purchase(u('f1')) $$,
  '42501', 'read-only: this shop records on its register PC', 'G15 the owner: receive_purchase');
select throws_ok($$ select public.add_inventory_item('{"name":"New A33","sale_price":10}'::jsonb, 0) $$,
  '42501', 'read-only: this shop records on its register PC', 'G16 the owner: add_inventory_item');
select throws_ok($$ select public.create_staff_role('Helper33') $$,
  '42501', 'read-only: this shop records on its register PC', 'G17 the owner: create_staff_role');
select throws_ok($$ select public.set_role_permission(u('a2'), 'notes.create', true) $$,
  '42501', 'read-only: this shop records on its register PC', 'G18 the owner: set_role_permission');
select throws_ok($$ select public.set_user_permission(u('14'), 'notes.create', true) $$,
  '42501', 'read-only: this shop records on its register PC', 'G19 the owner: set_user_permission');
select throws_ok($$ select public.set_staff_access(u('14'), u('a2'), false) $$,
  '42501', 'read-only: this shop records on its register PC', 'G20 the owner: set_staff_access');
select throws_ok($$ insert into public.settings (key, value) values ('k033', 'v')
                    on conflict (store_id, key) do update set value = excluded.value $$,
  '42501', 'read-only: this shop records on its register PC', 'G21 the owner: a direct settings upsert');
select throws_ok($$ insert into public.customers (name) values ('Walk-in A33') $$,
  '42501', 'read-only: this shop records on its register PC',
  'G22 the owner: a customers insert with store_id omitted (filled with A by the tenant trigger, then refused)');
reset role;

select _as(null);
insert into auth.users (id, email) values (u('19'), 'svc33@t33');
set role service_role;
select throws_ok($$ insert into public.users (id, username, password_hash, store_id, role_id, is_active)
                    values (u('19'), 'svc_a33', 'supabase-auth', s_a(), u('a2'), true) $$,
  '42501', 'read-only: this shop records on its register PC',
  'G23 the service role inserting a users row in A (what create-user would do)');
reset role;

select throws_ok($$ update public.customers set phone = '0199' where id = u('91') $$,
  '42501', 'read-only: this shop records on its register PC',
  'G24 postgres (a migration) updating A''s customer without the bypass');
select _admin_guc(s_a());
select throws_ok($$ update public.customers set phone = '0199' where id = u('91') $$,
  '42501', 'read-only: this shop records on its register PC',
  'G24b ...or with lensy.register_admin set but no token (only the definer functions open one)');
select _token(s_a(), 'ingest', true);
select throws_ok($$ update public.customers set phone = '0199' where id = u('91') $$,
  '42501', 'read-only: this shop records on its register PC',
  'G24c ...or with an ingest token instead of the admin one');
select _token(s_a(), 'ingest', false);
select is(_a_counts(), (select v from _snap where k = 'a'), 'G25 nothing in A moved');
select _token(s_a(), 'admin', true);
select lives_ok($$ update public.customers set phone = '0199' where id = u('91') $$,
  'G26 ...while the owner context WITH lensy.register_admin and its token does pass (why a migration must skip register_only stores)');
select _token(s_a(), 'admin', false);
select _admin_guc(null);

-- ===== W: what still works =================================================
set role authenticated; select _as(u('22'));
select lives_ok($$ select public.create_sale_order('{"total_amount":0,"discount":0,"net_amount":0,"amount_paid":0}'::jsonb,
                     '[]'::jsonb, '[{"exam_type":"distance"}]'::jsonb, '[]'::jsonb, null) $$,
  'W1 store B''s checkout');
select _as(u('11'));
select lives_ok($$ insert into public.note_seen (note_id, user_id) values (u('f3'), u('11')) $$,
  'W2 note_seen in A (the owner marks a note read)');
select ok((select count(*) from public.customers where store_id = s_a()) = 1
          and (select count(*) from public.sales where store_id = s_a()) = 3,
  'W3 the owner still reads A');
select _as(u('61'));
select lives_ok($$ update public.store_licenses set notes = 'renewed by the vendor 33' where store_id = s_a() $$,
  'W4 a platform admin''s store_licenses update in A');
select is((select count(*)::int from public.stores where id = s_a() and register_only), 1,
  'W5 a platform admin reads stores.register_only (the orphan scan skips such stores)');
reset role; select _as(null);
select is((select notes from public.store_licenses where store_id = s_a()), 'renewed by the vendor 33',
  'W6 ...and the licence change landed');

-- ===== P: the owner's phone ================================================
set role authenticated; select _as(u('11'));
select ok((public.my_permissions() ->> 'read_only')::boolean
          and (public.my_permissions() ->> 'is_owner')::boolean
          and not (public.my_permissions() ->> 'is_admin')::boolean
          and (public.my_permissions() ->> 'active')::boolean
          and (public.my_permissions() ->> 'assigned')::boolean,
  'P1 the owner: read_only true, is_owner true, is_admin false (still active and assigned)');
select is(public.my_permissions() -> 'codes',
          (select jsonb_agg(c) from unnest(public.supported_permissions()) c where c like '%.view'),
  'P2 ...and exactly the view codes');
select _as(u('12'));
select ok((public.my_permissions() ->> 'read_only')::boolean
          and not (public.my_permissions() ->> 'is_owner')::boolean
          and not (public.my_permissions() ->> 'is_admin')::boolean,
  'P3 a second admin: read_only, not the owner, no admin bypass');
select _as(u('14'));
select is(public.my_permissions() -> 'codes', '["pos.view", "history.view", "notes.view"]'::jsonb,
  'P4 a cashier keeps only the view codes it had (pos.create dropped)');
select ok(public.store_is_register_only(s_a()), 'P5 store_is_register_only answers true to the store''s own staff');
select _as(u('61'));
select ok(public.store_is_register_only(s_a()) and not public.store_is_register_only(s_b())
          and not public.store_is_register_only(null),
  'P6 ...and to the vendor naming the store (create-user''s 409 check); false for an ordinary or no store');
-- With A register_only, nobody else's answer moves (design 4.3 "unchanged answer for B").
select is(public.my_permissions(), _mp029() || '{"read_only": false, "is_owner": false}'::jsonb,
  'P7 while A is register_only the vendor still gets 029''s answer');
select _as(u('22'));
select is(public.my_permissions(), _mp029() || '{"read_only": false, "is_owner": false}'::jsonb,
  'P8 ...and so does B''s seller (every code it had, write codes included)');
select _as(u('21'));
select is(public.my_permissions(), _mp029() || '{"read_only": false, "is_owner": true}'::jsonb,
  'P9 ...and B''s owner: a full admin, is_owner true');
reset role; select _as(null);

-- ===== IG: the ingest gate =================================================
-- A staff session of an ordinary store setting the ingest GUCs itself.
set role authenticated; select _as(u('22'));
select _ingest('1', s_b(), u('21'), '2020-01-02 03:04:05+00');
select public.set_lab_status(u('e4'), 'Ready');
select _ingest(null, null, null, null);
reset role; select _as(null);
select ok((select actor = u('22') and not via_register and event_at is null and store_id = s_b()
             from public.audit_log where table_name = 'sales' and row_id = u('e4')::text and action = 'update'
            order by id desc limit 1),
  'IG1 a staff session setting lensy.ingest/actor/event_at is audited as itself, not via the register');
select ok((select lab_status_changed_at = now() and lab_ready_at = now() from public.sales where id = u('e4')),
  'IG2 ...and its lab stamp is now(), not the GUC''s time');

-- The register's path: a definer context (here postgres) with the register's
-- JWT, the GUCs register_ingest (034) sets and the ingest token it opens.
select _as(u('71'));
select _ingest('1', s_a(), u('14'), '2026-01-02 03:04:05+00');
select throws_ok($$ update public.sales set lab_status = 'Ready' where id = u('e1') $$,
  '42501', 'read-only: this shop records on its register PC',
  'IG3a the GUCs and the register''s JWT without the ingest token are refused (no client can write a token)');
update public.store_licenses set notes = 'ig33' where store_id = s_a();
select ok((select actor = u('71') and not via_register and event_at is null and store_id = s_a()
             from public.audit_log where table_name = 'store_licenses' and action = 'update'
            order by id desc limit 1),
  'IG3b ...and audit_row ignores them too (store_licenses is audited but not guarded)');
select _token(s_a(), 'ingest', true);
select lives_ok($$ update public.sales set lab_status = 'Ready' where id = u('e1') $$,
  'IG3 on the ingest path, token open, the register''s store accepts the write');
select ok((select actor = u('14') and via_register and event_at = '2026-01-02 03:04:05+00'::timestamptz and store_id = s_a()
             from public.audit_log where table_name = 'sales' and row_id = u('e1')::text and action = 'update'
            order by id desc limit 1)
          and (select lab_status_changed_at = '2026-01-02 03:04:05+00'::timestamptz
                      and lab_ready_at = '2026-01-02 03:04:05+00'::timestamptz
                 from public.sales where id = u('e1')),
  'IG4 ...audited with the op''s actor, via_register and event_at; the lab stamp is the event time');
select _as(u('11'));
select throws_ok($$ update public.sales set lab_status = 'Received' where id = u('e1') $$,
  '42501', 'read-only: this shop records on its register PC',
  'IG5 the same GUCs and token under a JWT that is not the register are refused');
select _as(u('71'));
set role authenticated;
select throws_ok($$ insert into public.customers (name, store_id) values ('Forged33', s_a()) $$,
  '42501', 'read-only: this shop records on its register PC',
  'IG6 the register''s own client session cannot use the ingest path (owner context only)');
reset role;
select _token(s_a(), 'ingest', false);
select _ingest(null, null, null, null); select _as(null);

-- ===== ST: storage =========================================================
insert into storage.objects (bucket_id, name) values
  ('prescriptions', 'store/' || s_a() || '/orders/old33.jpg'),
  ('prescriptions', 'root33.jpg'),
  ('prescriptions', 'drop/' || s_a() || '/t33.jpg');

set role authenticated; select _as(u('71'));
select lives_ok($$ insert into storage.objects (bucket_id, name)
                   values ('prescriptions', 'store/' || s_a() || '/orders/new33.jpg') $$,
  'ST1 the register inserts a photo in store/<A>/orders');
select is(_n($$ update storage.objects set name = name || '.x' where name = 'store/' || s_a() || '/orders/new33.jpg' $$), 0,
  'ST2 ...but cannot overwrite (update) it');
select is(_n($$ delete from storage.objects where name = 'store/' || s_a() || '/orders/old33.jpg' $$), 0,
  'ST3 ...nor delete a photo');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('prescriptions', 'store/' || s_b() || '/orders/x33.jpg') $$, '42501', null,
  'ST4 ...nor insert in another store''s folder');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('prescriptions', 'store/' || s_a() || '/other/x33.jpg') $$, '42501', null,
  'ST5 ...nor outside store/<A>/orders');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('prescriptions', 'rootx33.jpg') $$,
  '42501', null, 'ST6 ...nor at the legacy root');
select is((select count(*)::int from storage.objects where name like 'store/' || s_a() || '/%'), 2,
  'ST7 it reads its store folder while the setup window is open');
select is(_n($$ delete from storage.objects where name = 'drop/' || s_a() || '/t33.jpg' $$), 1,
  'ST8 it deletes a fetched QR drop file in drop/<A>/');
select _as(u('11'));
select is(_n($$ delete from storage.objects where name = 'root33.jpg' $$), 0,
  'ST9 the owner cannot delete a legacy root photo (A is the oldest store and register_only)');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('prescriptions', 'store/' || s_a() || '/orders/phone33.jpg') $$, '42501', null,
  'ST10 the owner''s phone cannot upload into A');
select is((select count(*)::int from storage.objects where name like 'store/' || s_a() || '/%'), 2,
  'ST11 the owner still SELECTs the objects in A''s folder');
-- 008's FOR ALL policy would let the owner rename them; only 033's
-- restrictive UPDATE policy stops it.
select is(_n($$ update storage.objects set name = name || '.x' where name = 'store/' || s_a() || '/orders/old33.jpg' $$), 0,
  'ST11b ...but cannot rename (update) them');
select is(_n($$ update storage.objects set name = name || '.x' where name = 'root33.jpg' $$), 0,
  'ST11c ...nor a legacy root photo');
-- Every path outside store/ is a legacy root path to 008, drop/ included.
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('prescriptions', 'drop/x33.jpg') $$,
  '42501', null, 'ST11d the owner cannot upload under drop/ (008''s legacy root, and A is the oldest store)');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('prescriptions', 'drop/' || s_b() || '/x33.jpg') $$,
  '42501', null, 'ST11e ...not under another store''s drop/ folder');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('prescriptions', 'drop/notastore/x33.jpg') $$,
  '42501', null, 'ST11f ...nor under a drop/ folder that names no store');
select _as(u('14'));
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('prescriptions', 'drop/c33.jpg') $$,
  '42501', null, 'ST11g ...and neither can A''s cashier');
select _as(u('11'));
reset role;
insert into storage.objects (bucket_id, name) values ('prescriptions', 'drop/' || s_a() || '/t34.jpg');
set role authenticated;
select is((select count(*)::int from storage.objects where name like 'drop/%'), 0,
  'ST12 drop/ files are not shown to the store''s staff (008''s legacy-root branch would have)');
select _as(u('61'));
select is(_n($$ delete from storage.objects where name = 'store/' || s_a() || '/orders/old33.jpg' $$), 0,
  'ST13 a platform admin cannot delete A''s photos either');
select is(_n($$ update storage.objects set name = name || '.x' where name like 'store/' || s_a() || '/orders/%' $$), 0,
  'ST13b ...nor rename (update) them');
select _as(u('21'));
select lives_ok($$ insert into storage.objects (bucket_id, name)
                   values ('prescriptions', 'store/' || s_b() || '/orders/ok33.jpg') $$,
  'ST14 an ordinary store''s admin uploads as before');
select is(_n($$ update storage.objects set name = 'store/' || s_b() || '/orders/ok33b.jpg'
                 where name = 'store/' || s_b() || '/orders/ok33.jpg' $$), 1,
  'ST14b ...renames (updates) as before');
select is(_n($$ delete from storage.objects where name = 'store/' || s_b() || '/orders/ok33b.jpg' $$), 1,
  'ST15 ...and deletes as before');
reset role; select _as(null);
update public.store_registers set snapshot_done_at = now() where store_id = s_a();
set role authenticated; select _as(u('71'));
select ok((select count(*) from storage.objects where name like 'store/' || s_a() || '/%') = 0
          and (select count(*) from storage.objects where name like 'drop/' || s_a() || '/%') = 1,
  'ST16 once setup is done the register no longer reads its store folder, only its drop folder');
reset role; select _as(null);
update public.store_registers set snapshot_done_at = null, snapshot_until = now() - interval '1 minute'
 where store_id = s_a();
set role authenticated; select _as(u('71'));
select ok((select count(*) from storage.objects where name like 'store/' || s_a() || '/%') = 0
          and (select count(*) from storage.objects where name like 'drop/' || s_a() || '/%') = 1,
  'ST17 ...nor once its 24 h window (snapshot_until) has passed with setup unfinished');
reset role; select _as(null);

-- ===== T: QR photo tickets =================================================
set role service_role;
insert into _r select 'install_c', public._register_install(s_c(), u('72'), u('31'));
reset role;
set role authenticated; select _as(u('71'));
insert into _r select 't1', public.register_photo_ticket('000153', 'rx');
insert into _r select 't2', public.register_photo_ticket('000154', 'frame');
select throws_ok($$ select public.register_photo_ticket('000153', 'side') $$, '22023', null,
  'T1 a ticket names rx or frame');
select throws_ok($$ select public.register_photo_ticket('../000153', 'rx') $$, '22023', null,
  'T2 ...and a plain invoice number');
select _as(u('11'));
select throws_ok($$ select public.register_photo_ticket('000153', 'rx') $$, '42501', null,
  'T3 a ticket is refused to anyone but the register (the owner here)');
select _as(u('72'));
insert into _r select 't3', public.register_photo_ticket('C33-1', 'rx');
reset role; select _as(null);
select ok((select store_id = s_a() and invoice_no = '000153' and slot = 'rx' and used_at is null
                  and expires_at = now() + interval '15 minutes'
             from public.register_photo_tickets where id = (select (j ->> 'ticket')::uuid from _r where k = 't1'))
          and (select store_id = s_c() from public.register_photo_tickets
                where id = (select (j ->> 'ticket')::uuid from _r where k = 't3')),
  'T4 a ticket is the caller''s store''s, valid for 15 minutes');
set role service_role;
insert into _r select 'use1', public.register_photo_ticket_use((select (j ->> 'ticket')::uuid from _r where k = 't1'));
select throws_ok($$ select public.register_photo_ticket_use((select (j ->> 'ticket')::uuid from _r where k = 't1')) $$,
  '22023', null, 'T5 a ticket is single-use');
reset role;
select is((select j ->> 'path' from _r where k = 'use1'),
          'drop/' || s_a() || '/' || (select j ->> 'ticket' from _r where k = 't1') || '.jpg',
  'T6 using it returns drop/<store>/<ticket>.jpg');
update public.register_photo_tickets set expires_at = now() - interval '1 minute'
 where id = (select (j ->> 'ticket')::uuid from _r where k = 't2');
set role service_role;
select throws_ok($$ select public.register_photo_ticket_use((select (j ->> 'ticket')::uuid from _r where k = 't2')) $$,
  '22023', null, 'T7 an expired ticket cannot be used');
reset role;
set role authenticated; select _as(u('72'));
select ok(not exists (select 1 from public.register_photo_tickets_open()
                       where id = (select (j ->> 'ticket')::uuid from _r where k = 't1')),
  'T8 another store''s register does not see the ticket');
select throws_ok($$ select public.register_photo_fetched((select (j ->> 'ticket')::uuid from _r where k = 't1')) $$,
  'P0002', null, 'T9 ...nor mark it fetched');
select _as(u('71'));
select is((select string_agg(path, ',') from public.register_photo_tickets_open()),
          (select j ->> 'path' from _r where k = 'use1'),
  'T10 the register lists its used, unfetched ticket with the path');
select lives_ok($$ select public.register_photo_fetched((select (j ->> 'ticket')::uuid from _r where k = 't1')) $$,
  'T11 it marks it fetched');
select lives_ok($$ select public.register_photo_fetched((select (j ->> 'ticket')::uuid from _r where k = 't1')) $$,
  'T12 marking it again is harmless (a retried call after a lost response)');
select ok(not exists (select 1 from public.register_photo_tickets_open()),
  'T13 ...and it has left the open list');
reset role; select _as(null);

-- ===== Q: a quarantined register (seq conflict, design 3.3) is nobody ======
update public.store_registers set quarantined_at = now() where store_id = s_a();
set role authenticated; select _as(u('71'));
select is(public.register_store_id(), null::uuid, 'Q1 a quarantined register login resolves to no store');
select throws_ok($$ select public.register_photo_ticket('000160', 'rx') $$, '42501', null,
  'Q2 ...gets no photo ticket');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('prescriptions', 'store/' || s_a() || '/orders/q33.jpg') $$, '42501', null,
  'Q3 ...and cannot upload a photo');
reset role;
update public.store_registers set quarantined_at = null where store_id = s_a();
set role authenticated;
select is(public.register_store_id(), s_a(), 'Q4 cleared again, it is A''s register (the quarantine was the only difference)');
reset role; select _as(null);

-- ===== CM: the owner's switch-off command ==================================
set role authenticated; select _as(u('11'));
insert into _r select 'cmd1', to_jsonb(public.owner_deactivate_staff(u('13')));
insert into _r select 'cmd2', to_jsonb(public.owner_deactivate_staff(u('13')));
reset role; select _as(null);
select ok((select (j #>> '{}')::uuid from _r where k = 'cmd1') = (select (j #>> '{}')::uuid from _r where k = 'cmd2')
          and (select count(*) from public.register_commands where user_id = u('13') and applied_seq is null) = 1
          and (select store_id = s_a() and kind = 'staff.deactivate' and issued_by = u('11')
                 from public.register_commands where id = (select (j #>> '{}')::uuid from _r where k = 'cmd1')),
  'CM1 the owner queues ONE open staff.deactivate command for a register-local cashier (asking twice returns it)');
select ok((select is_active from public.users where id = u('13')),
  'CM2 the command changes no staff row in the cloud (the PC applies it)');
set role authenticated; select _as(u('12'));
select throws_ok($$ select public.owner_deactivate_staff(u('13')) $$, '42501', null,
  'CM3 another admin of the store, not the owner, is refused');
select _as(u('21'));
select throws_ok($$ select public.owner_deactivate_staff(u('13')) $$, '42501', null,
  'CM4 another store''s owner is refused');
select _as(u('71'));
select throws_ok($$ select public.owner_deactivate_staff(u('13')) $$, '42501', null,
  'CM5 the register''s JWT is refused');
select _as(u('11'));
select throws_ok($$ select public.owner_deactivate_staff(u('14')) $$, '42501', null,
  'CM6 a cloud login is a protected target');
select throws_ok($$ select public.owner_deactivate_staff(u('11')) $$, '42501', null,
  'CM7 so is the owner');
select _as(u('21'));
select throws_ok($$ select public.owner_deactivate_staff(u('22')) $$, '55000', null,
  'CM8 an ordinary store has no register to send a command to');
reset role; select _as(null);

-- ===== RS: register_status and register_flags ==============================
set role authenticated; select _as(u('11'));
select is(public.register_status() - 'claimed_at',
  '{"state": "active", "epoch": 1, "last_ingest_at": null, "last_contact_at": null, "acked_seq": 0,
    "pending_reported": null, "oldest_pending_at": null, "held": null, "alert": null, "alert_at": null,
    "revoked_at": null, "quarantined_at": null, "conflict_seq": null, "flags_total": 0, "refused_total": 0,
    "skipped_total": 0, "parked_total": 0, "convert_pending": 3}'::jsonb,
  'RS1 the owner reads the register''s state (nothing synced yet; three staff rows still to convert)');
reset role; select _as(null);
update public.store_registers
   set last_ingest_at = '2026-11-27 09:30:00+00', last_contact_at = '2026-11-27 09:31:00+00',
       pending_reported = 4, oldest_pending_at = '2026-11-27 08:00:00+00', last_seq = 9
 where store_id = s_a();
insert into public.register_ops (store_id, seq, op_id, kind, actor, occurred_at, status, violations, detail, payload) values
  (s_a(), 1, gen_random_uuid(), 'customer.upsert', u('14'), now(), 'ok', '{}', null, '{"name":"SECRET33"}'),
  (s_a(), 2, gen_random_uuid(), 'sale.create', u('14'), now(), 'flagged', '{perm:pos.create}',
   '{"summary": "000155 sale 100"}', '{"customer":"SECRET33"}'),
  (s_a(), 3, gen_random_uuid(), 'staff.set_access', u('99'), now(), 'refused', '{foreign_actor}', null, '{"x":"SECRET33"}');
set role authenticated; select _as(u('12'));
select ok((select (s ->> 'last_ingest_at')::timestamptz = '2026-11-27 09:30:00+00'
                  and (s ->> 'pending_reported')::int = 4 and (s ->> 'acked_seq')::int = 9
                  and (s ->> 'flags_total')::int = 1 and (s ->> 'refused_total')::int = 1
             from (select public.register_status() as s) x),
  'RS2 any member of the store reads the freshness and the flag/refusal totals');
select is((select string_agg(seq || ':' || status || ':' || array_to_string(violations, ';') || ':' || summary
                             || ':' || coalesce(actor_name, '-'), ' / ' order by seq desc)
             from public.register_flags(10)),
  '3:refused:foreign_actor:staff.set_access:- / 2:flagged:perm:pos.create:000155 sale 100:cashier_a33',
  'RS3 register_flags lists the non-ok ops newest first: codes, actor and a short summary');
select ok(not exists (select 1 from public.register_flags(10) f where to_jsonb(f)::text like '%SECRET33%')
          and pg_get_function_result('public.register_flags(integer)'::regprocedure) not like '%payload%',
  'RS4 ...never the payload');
select _as(u('22'));
select ok(public.register_status() is null and not exists (select 1 from public.register_flags(10)),
  'RS5 another store''s staff see nothing of it');
reset role; select _as(null);

-- ===== BY: set_store_owner on a register_only store; a re-claim ============
set role authenticated; select _as(u('61'));
select lives_ok($$ select public.set_store_owner(s_a(), u('12')) $$,
  'BY1 the vendor changes A''s owner although A is register_only (its bypass)');
select is(coalesce(current_setting('lensy.register_admin', true), ''), '',
  'BY2 ...and the bypass is not left behind in the session');
reset role; select _as(null);
select ok((select owner_uid = u('12') from public.stores where id = s_a())
          and (select revoked_at is not null from public.store_registers where store_id = s_a()),
  'BY3 the new owner is set and the register is revoked (its protected flags are stale)');
set role authenticated; select _as(u('61'));
select public.set_store_owner(s_a(), u('11'));
reset role;
set role service_role;
insert into _r select 'install_a2', public._register_install(s_a(), u('73'), u('11'));
reset role;
select ok((select (j ->> 'epoch')::int = 2 and (j ->> 'last_seq')::int = 9 and (j ->> 'previous_uid')::uuid = u('71')
             from _r where k = 'install_a2')
          and (select revoked_at is null and register_uid = u('73') from public.store_registers where store_id = s_a()),
  'BY4 a re-claim is epoch 2, keeps last_seq, clears the revocation and names the old login to ban');
set role authenticated; select _as(u('73'));
select is(public.register_store_id(), s_a(), 'BY5 the new register login resolves to A');
select _as(u('71'));
select is(public.register_store_id(), null, 'BY6 ...and the old one to nothing');
reset role; select _as(null);

-- ===== RV: revoke_register =================================================
set role authenticated; select _as(u('12'));
select throws_ok($$ select public.revoke_register(s_a()) $$, '42501', null,
  'RV1 a store admin who is not the owner cannot revoke');
select _as(u('11'));
select throws_ok($$ select public.revoke_register(s_b()) $$, '42501', null,
  'RV2 A''s owner cannot revoke another store''s register');
select _as(u('61'));
select lives_ok($$ select public.revoke_register(s_a()) $$, 'RV3 a platform admin revokes A''s register');
select _as(u('73'));
select is(public.register_store_id(), null, 'RV4 the revoked login resolves to nothing');
select _as(u('11'));
select lives_ok($$ select public.revoke_register(s_a()) $$, 'RV5 the owner may revoke too (again: no error)');
select is(public.register_status() ->> 'state', 'revoked', 'RV6 the phone shows it revoked');
select _as(u('61'));
select throws_ok($$ select public.revoke_register(s_d()) $$, 'P0002', null, 'RV7 a store with no register: nothing to revoke');
reset role; select _as(null);

-- ===== RL: release_register (C, register r2) ===============================
set role authenticated; select _as(u('21'));
select throws_ok($$ select public.release_register(s_c()) $$, '42501', null,
  'RL1 another store''s owner cannot release C''s register');
reset role;
update public.store_registers set pending_reported = 3 where store_id = s_c();
set role authenticated; select _as(u('31'));
select throws_ok($$ select public.release_register(s_c()) $$, '55000', null,
  'RL2 not while the PC reports unsent changes');
reset role;
update public.store_registers set pending_reported = 0 where store_id = s_c();
set role authenticated; select _as(u('31'));
select is(public.release_register(s_c()), u('72'), 'RL3 the owner releases it and learns the login to ban');
select ok(public.register_status() ->> 'state' = 'released'
          and (public.my_permissions() ->> 'read_only')::boolean,
  'RL4 the shop stays in register mode with no register computer');
select throws_ok($$ select public.release_register(s_c()) $$, '55000', null, 'RL5 there is nothing left to release');
select _as(u('72'));
select is(public.register_store_id(), null, 'RL6 the released login resolves to nothing');
reset role; select _as(null);

-- ===== CV: staff conversion on register_only A =============================
set role service_role;
insert into _r select 'conv', to_jsonb(public._register_convert_staff(s_a()));
reset role;
select is((select j from _r where k = 'conv'), to_jsonb(array[u('12'), u('14')]),
  'CV1 _register_convert_staff on register_only A returns the cloud logins to ban (not the owner, not local rows)');
set role authenticated; select _as(u('11'));
select is((public.register_status() ->> 'convert_pending')::int, 3,
  'CV2 convert_pending counts them and the legacy row with no login');
reset role;
set role service_role;
select is(public._register_mark_local(s_a(), array[u('12'), u('14')]), 3,
  'CV3 _register_mark_local on A marks the two banned logins and the legacy row register-local');
reset role;
select is((select string_agg(username || '=' || password_hash, ', ' order by username)
             from public.users where store_id = s_a()),
  'admin2_a33=register-local, ahmed=register-local, cashier_a33=register-local, legacy_a33=register-local, mona=register-local, owner_a33=supabase-auth',
  'CV4 every staff row but the owner''s is register-local');
set role authenticated; select _as(u('11'));
select is((public.register_status() ->> 'convert_pending')::int, 0, 'CV5 nothing left to convert');
reset role; select _as(null);

-- ===== EM: end_register_mode ===============================================
update public.store_registers set pending_reported = 2 where store_id = s_a();
set role authenticated; select _as(u('12'));
select throws_ok($$ select public.end_register_mode(s_a(), false) $$, '42501', null,
  'EM1 a staff member who is not the owner cannot end register mode');
select _as(u('11'));
select throws_ok($$ select public.end_register_mode(s_a(), false) $$, '55000', null,
  'EM2 the owner is refused while the PC reports unsent changes');
select throws_ok($$ select public.end_register_mode(s_a(), true) $$, '42501', null,
  'EM3 ...and may not force it (only the vendor forces, for a lost PC)');
select _as(u('61'));
insert into _r select 'end_a', public.end_register_mode(s_a(), true);
reset role; select _as(null);
select is((select j from _r where k = 'end_a'), '{"next_invoice": 153, "register_local_users": 5}'::jsonb,
  'EM4 the vendor forces it: the counter continues after the PC''s 000152; five register-local logins');
select ok(not (select register_only from public.stores where id = s_a())
          and (select revoked_at is not null from public.store_registers where store_id = s_a())
          and (select next_val from public.invoice_counter where store_id = s_a() and prefix = '') = 153,
  'EM5 A is no longer register_only, its register is revoked, invoice_counter is 153');
select is((select string_agg(username || ':' || is_active, ', ' order by username)
             from public.users where store_id = s_a() and password_hash = 'register-local'),
  'admin2_a33~local-33000000:false, ahmed~local-33000000:false, cashier_a33~local-33000000:false, legacy_a33~local-33000000:false, mona~local-33000000:false',
  'EM6 every register-local login, active (ahmed) or not (mona), is off and renamed ~local-<id>');
select is((select username || ':' || is_active from public.users where id = u('11')), 'owner_a33:true',
  'EM7 the owner''s cloud login is untouched');
insert into auth.users (id, email) values (u('18'), 'ahmed@t33');
set role service_role;
select lives_ok($$ insert into public.users (id, username, full_name, password_hash, role_id, store_id, is_active)
                   values (u('18'), 'ahmed', 'Ahmed', 'supabase-auth', u('a2'), s_a(), true) $$,
  'EM8 create-user''s insert of a cloud ''ahmed'' in A now succeeds');
reset role;
set role authenticated; select _as(u('11'));
select ok(not (public.my_permissions() ->> 'read_only')::boolean and (public.my_permissions() ->> 'is_admin')::boolean,
  'EM9 the owner''s phone is an ordinary admin again');
select _as(u('61'));
select throws_ok($$ select public.end_register_mode(s_a(), false) $$, '55000', null,
  'EM10 ending it twice is refused (not in register mode)');
reset role; select _as(null);

-- ===== UN: usernames per store =============================================
select lives_ok($$ insert into public.users (id, username, password_hash, store_id, is_active) values
                     (u('26'), 'ahmed', 'register-local', s_b(), true),
                     (u('43'), 'ahmed', 'register-local', s_d(), true) $$,
  'UN1 register-local ''ahmed'' in two stores');
insert into auth.users (id, email) values (u('52'), 'ahmed.e@t33');
select throws_ok($$ insert into public.users (id, username, password_hash, store_id, is_active)
                    values (u('52'), 'ahmed', 'supabase-auth', s_e(), true) $$,
  '23505', 'duplicate key value violates unique constraint "users_cloud_username_key"',
  'UN2 a cloud login ''ahmed'' reused in another store -> 23505');
select throws_ok($$ insert into public.users (id, username, password_hash, store_id, is_active)
                    values (u('27'), 'Ahmed ', 'register-local', s_b(), true) $$,
  '23505', 'duplicate key value violates unique constraint "users_store_username_key"',
  'UN3 ''Ahmed '' next to ''ahmed'' in one store -> 23505');

-- ===== OW: deleting an owner's login =======================================
select lives_ok($$ delete from auth.users where id = u('21') $$,
  'OW1 the owner login of an ordinary store can still be deleted...');
select is((select owner_uid from public.stores where id = s_b()), null::uuid, 'OW2 ...and the store simply has no owner');
select throws_ok($$ delete from auth.users where id = u('31') $$,
  '42501', 'read-only: this shop records on its register PC',
  'OW3 a register_only store''s owner login is not: change the owner with set_store_owner first');

-- ===== EM, continued: a counter already past the PC's numbers ==============
-- C (register_only since T, its PC released in RL, nothing pending) has
-- invoice_counter 500 while its highest invoice is 000200.
set role authenticated; select _as(u('31'));
insert into _r select 'end_c', public.end_register_mode(s_c(), false);
reset role; select _as(null);
select ok((select j from _r where k = 'end_c') = '{"next_invoice": 500, "register_local_users": 0}'::jsonb
          and (select next_val from public.invoice_counter where store_id = s_c() and prefix = '') = 500
          and not (select register_only from public.stores where id = s_c()),
  'EM11 C''s owner ends register mode; a counter above the highest invoice + 1 (500 > 201) is kept, never lowered');

select * from finish();
rollback;
