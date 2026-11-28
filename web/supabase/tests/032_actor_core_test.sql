-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 032 gate (offline-v2 Phase 1, docs/offline-v2/design.md section 4.2).
--
-- R   there is ONE resolve_can and ONE is_store_admin, still callable by a
--     signed-in user; resolve_can's ACL is untouched (PUBLIC/anon keep the
--     EXECUTE they always had, and anon gets false, not an error), while
--     is_store_admin stays revoked from anon as 029 left it.
-- X   C1: a store user asking resolve_can / is_store_admin about a person of
--     ANOTHER store gets false; asking about a colleague or about yourself is
--     unchanged; a caller with no signed-in user gets false about others.
-- P   a platform admin is unchanged: true for itself, and sees any store.
-- PA  _resolve_can_for / _is_store_admin_for agree with resolve_can /
--     is_store_admin for every fixture user (platform admins excluded) and
--     every code, asked by the user and by a platform admin, AND with a copy
--     of 029's rule kept here as the oracle (so the refactor changed nothing
--     for a store's own users). They answer only for the named store, have no
--     platform branch, and refuse inactive or mismatched-role users.
-- I   the internals are not executable by anon or authenticated.
-- Z   C2: z_report equals _z_report on the 023 fixture (and the 023 figures),
--     _z_report reads a named store without a JWT, the result type is kept.
-- T   tender_key on the shared table ('Cash ', ' INSTAPAY', '', null,
--     'cash + instapay', tab, NBSP), immutable.
-- M   M1: the three actor columns reference public.users ON DELETE SET NULL
--     and are validated; an auth-only id fails 23503, also via the default.
-- S   sale_payments.store_id is NOT NULL.
-- ST  settings_key_key is gone: two stores share a key, one store cannot
--     repeat it.
-- W   weighted cost: 10 @ 4 then 10 @ 6 is 5.00 (also within one purchase);
--     an empty or negative shelf takes the delivery's cost.
-- MP  the paste survives the pre-032 state that used to abort it: two
--     NULL-store payments, recorded by a non-staff sign-in, on a sale voided
--     by a non-staff sign-in. _repoint_actor_keys() (what the paste runs)
--     backfills store_id without touching the sale, warns and leaves the two
--     orphaned keys NOT VALID, and validates them when re-run after a fix.
begin;
create extension if not exists pgtap;
select plan(67);

-- ===== fixtures ============================================================
insert into public.stores (id, name) values
  ('32000000-0000-4000-8000-0000000000a0', 'Store A32'),
  ('32000000-0000-4000-8000-0000000000b0', 'Store B32')
on conflict (id) do nothing;
create function s_a() returns uuid language sql stable as $$ select '32000000-0000-4000-8000-0000000000a0'::uuid $$;
create function s_b() returns uuid language sql stable as $$ select '32000000-0000-4000-8000-0000000000b0'::uuid $$;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (s_a(), 'STORE-A32', 'pro', null), (s_b(), 'STORE-B32', 'pro', null)
on conflict (store_id) do nothing;

-- Roles. A: owner, Cashier32 (history + lab view), Seller32 (nothing).
--        B: Admin, Clerk32 (reports, closing, suppliers).
insert into public.roles (id, name, store_id) values
  ('32000000-0000-4000-8000-0000000000a1', 'owner',     s_a()),
  ('32000000-0000-4000-8000-0000000000a2', 'Cashier32', s_a()),
  ('32000000-0000-4000-8000-0000000000a3', 'Seller32',  s_a()),
  ('32000000-0000-4000-8000-0000000000b1', 'Admin',     s_b()),
  ('32000000-0000-4000-8000-0000000000b2', 'Clerk32',   s_b());
insert into public.role_permissions (role_id, permission_id)
select '32000000-0000-4000-8000-0000000000a2'::uuid, p.id from public.permissions p
 where p.code in ('history.view', 'history.edit', 'lab.view', 'pos.view', 'pos.create');
insert into public.role_permissions (role_id, permission_id)
select '32000000-0000-4000-8000-0000000000b2'::uuid, p.id from public.permissions p
 where p.code in ('reports.view', 'closing.view', 'closing.edit', 'suppliers.view', 'suppliers.edit', 'lab.edit');

-- Users. a1 owner; a2 cashier with a Deny on pos.create; a3 seller with an
-- Allow on lab.edit (no lab.view, so the View rule refuses it) and an Allow on
-- notes.view + notes.create; a4 inactive cashier; a5 no role; a6 in A holding
-- B's role (mismatch); b1 admin; b2 clerk with a Deny on closing.edit.
-- p1 is a platform admin and x1 an auth-only sign-in (no staff row).
insert into auth.users (id, email) values
  ('32000000-0000-4000-8000-000000000011', 'a1@t32'), ('32000000-0000-4000-8000-000000000012', 'a2@t32'),
  ('32000000-0000-4000-8000-000000000013', 'a3@t32'), ('32000000-0000-4000-8000-000000000014', 'a4@t32'),
  ('32000000-0000-4000-8000-000000000015', 'a5@t32'), ('32000000-0000-4000-8000-000000000016', 'a6@t32'),
  ('32000000-0000-4000-8000-000000000021', 'b1@t32'), ('32000000-0000-4000-8000-000000000022', 'b2@t32'),
  ('32000000-0000-4000-8000-000000000031', 'p1@t32'), ('32000000-0000-4000-8000-000000000041', 'x1@t32');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('32000000-0000-4000-8000-000000000011', 'a1_32', '-', s_a(), '32000000-0000-4000-8000-0000000000a1', true),
  ('32000000-0000-4000-8000-000000000012', 'a2_32', '-', s_a(), '32000000-0000-4000-8000-0000000000a2', true),
  ('32000000-0000-4000-8000-000000000013', 'a3_32', '-', s_a(), '32000000-0000-4000-8000-0000000000a3', true),
  ('32000000-0000-4000-8000-000000000014', 'a4_32', '-', s_a(), '32000000-0000-4000-8000-0000000000a2', false),
  ('32000000-0000-4000-8000-000000000015', 'a5_32', '-', s_a(), null, true),
  ('32000000-0000-4000-8000-000000000016', 'a6_32', '-', s_a(), '32000000-0000-4000-8000-0000000000b1', true),
  ('32000000-0000-4000-8000-000000000021', 'b1_32', '-', s_b(), '32000000-0000-4000-8000-0000000000b1', true),
  ('32000000-0000-4000-8000-000000000022', 'b2_32', '-', s_b(), '32000000-0000-4000-8000-0000000000b2', true);
insert into public.user_permissions (user_id, permission_id, allow)
select v.u::uuid, p.id, v.a from (values
  ('32000000-0000-4000-8000-000000000012', 'pos.create',   false),
  ('32000000-0000-4000-8000-000000000013', 'lab.edit',     true),
  ('32000000-0000-4000-8000-000000000013', 'notes.view',   true),
  ('32000000-0000-4000-8000-000000000013', 'notes.create', true),
  ('32000000-0000-4000-8000-000000000016', 'lab.view',     true),
  ('32000000-0000-4000-8000-000000000022', 'closing.edit', false)) v(u, c, a)
join public.permissions p on p.code = v.c;
insert into public.platform_admins (auth_uid) values ('32000000-0000-4000-8000-000000000031');

create function u(p text) returns uuid language sql immutable as $$
  select ('32000000-0000-4000-8000-0000000000' || p)::uuid $$;

create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claims', case when p is null then '{}' else json_build_object('sub', p)::text end, true);
end $$;

-- 029's rule, copied verbatim as the parity oracle (pg_temp, so it cannot
-- leak): what resolve_can / is_store_admin answered before 032.
create function pg_temp.isa029(p_user uuid) returns boolean
language sql stable as $$
  select (p_user = auth.uid() and public.is_platform_admin()) or exists(
    select 1 from public.users u join public.roles r on r.id = u.role_id and r.store_id = u.store_id
    where u.id = p_user and u.is_active is true and lower(trim(r.name)) in ('admin','owner')
  )
$$;
create function pg_temp.rc029(p_code text, p_user uuid) returns boolean
language plpgsql stable as $$
declare v_code text := replace(p_code, 'purchases.', 'suppliers.'); v_role uuid; v_view text; v_allowed boolean;
begin
  if not (v_code = any(public.supported_permissions())) then return false; end if;
  if p_user = auth.uid() and public.is_platform_admin() then return true; end if;
  select u.role_id into v_role from public.users u
    join public.roles r on r.id = u.role_id and r.store_id = u.store_id
    where u.id = p_user and u.is_active is true;
  if v_role is null then return false; end if;
  if pg_temp.isa029(p_user) then return true; end if;
  select coalesce(
    (select up.allow from public.user_permissions up join public.permissions p on p.id=up.permission_id where up.user_id=p_user and p.code=v_code),
    exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where rp.role_id=v_role and p.code=v_code)
  ) into v_allowed;
  if not v_allowed then return false; end if;
  v_view := split_part(v_code,'.',1) || '.view';
  if v_code = v_view then return true; end if;
  return pg_temp.rc029(v_view, p_user);
end $$;

-- ===== R: one definition each, grant kept ==================================
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'resolve_can'), 1,
  'R1 there is exactly one resolve_can');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'is_store_admin'), 1,
  'R2 there is exactly one is_store_admin');
select ok(has_function_privilege('authenticated', 'public.resolve_can(text, uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.is_store_admin(uuid)', 'execute'),
  'R3 a signed-in user can still call resolve_can and is_store_admin');
select ok(has_function_privilege('anon', 'public.resolve_can(text, uuid)', 'execute')
          and (select bool_or(a.grantee = 0) from pg_proc p, aclexplode(p.proacl) a
                where p.oid = 'public.resolve_can(text, uuid)'::regprocedure and a.privilege_type = 'EXECUTE')
          and not has_function_privilege('anon', 'public.is_store_admin(uuid)', 'execute'),
  'R4 resolve_can keeps its grant (PUBLIC and anon still EXECUTE, as up to 031); is_store_admin stays revoked from anon (029)');
set role anon; select _as(null);
select is(public.resolve_can('reports.view', '32000000-0000-4000-8000-000000000022'::uuid), false,
  'R5 anon asking about a store user gets false, not permission denied');
reset role;

-- ===== X: no answers about another store ===================================
set role authenticated; select _as(u('11'));
select is(public.resolve_can('history.edit', u('12')), true,
  'X1 an owner may still ask about a colleague in the same store');
select is(public.resolve_can('reports.view', u('22')), false,
  'X2 ...but not about a person of another store (who does hold reports.view)');
select is(public.is_store_admin(u('21')), false,
  'X3 is_store_admin about another store''s admin is false');
select is(public.resolve_can('settings.edit'), true, 'X4 asking about yourself is unchanged (owner)');
select _as(u('12'));
select is(public.is_store_admin(u('11')), true,
  'X5 a cashier may still learn that a colleague is the owner');
select is(public.resolve_can('suppliers.edit', u('22')), false,
  'X6 a cashier asking about another store''s clerk gets false');
select _as(u('22'));
select is(public.resolve_can('reports.view'), true, 'X7 the clerk''s own answer is unchanged');
reset role;
select _as(null);
select is(public.resolve_can('reports.view', u('22')), false,
  'X8 with no signed-in user, a question about a store user is false');

-- ===== P: platform admin unchanged =========================================
set role authenticated; select _as(u('31'));
select is(public.resolve_can('settings.edit'), true, 'P1 a platform admin may do everything itself');
select ok(public.resolve_can('reports.view', u('22')) and public.resolve_can('history.edit', u('12'))
          and not public.resolve_can('closing.edit', u('22')),
  'P2 a platform admin sees the real answer for users of any store');
select ok(public.is_store_admin() and public.is_store_admin(u('21')) and not public.is_store_admin(u('12')),
  'P3 is_store_admin for a platform admin: itself true, other stores answered truthfully');
reset role;

-- ===== PA: parity ==========================================================
create table _codes (c text primary key);
insert into _codes select unnest(public.supported_permissions())
  union select 'purchases.edit' union select 'settings.delete' union select 'no.such';
create table _par (u uuid, c text, self_rc boolean, plat_rc boolean, int_rc boolean, old_rc boolean,
                   self_isa boolean, plat_isa boolean, int_isa boolean, old_isa boolean);
create function _fill_parity() returns void language plpgsql as $$
declare r record; k record;
begin
  for r in select x.id, x.store_id from public.users x
            where not exists (select 1 from public.platform_admins pa where pa.auth_uid = x.id) loop
    for k in select c from _codes loop
      perform _as(r.id);
      insert into _par (u, c, self_rc, int_rc, old_rc, self_isa, int_isa, old_isa)
      values (r.id, k.c, public.resolve_can(k.c, r.id),
              public._resolve_can_for(k.c, r.id, public.user_store(r.id)),
              pg_temp.rc029(k.c, r.id),
              public.is_store_admin(r.id),
              public._is_store_admin_for(r.id, public.user_store(r.id)),
              pg_temp.isa029(r.id));
      perform _as(u('31'));
      update _par set plat_rc = public.resolve_can(k.c, r.id), plat_isa = public.is_store_admin(r.id)
       where _par.u = r.id and _par.c = k.c;
    end loop;
  end loop;
end $$;
select _fill_parity();
select _as(null);

select cmp_ok((select count(distinct u)::int from _par), '>=', 8,
  'PA0 parity covers every fixture user (at least the eight made here)');
select is((select count(*)::int from _par where int_rc is distinct from self_rc), 0,
  'PA1 _resolve_can_for = resolve_can asked by the user, for every user and code');
select is((select count(*)::int from _par where int_rc is distinct from plat_rc), 0,
  'PA2 _resolve_can_for = resolve_can asked by a platform admin');
select is((select count(*)::int from _par where int_rc is distinct from old_rc), 0,
  'PA3 _resolve_can_for = 029''s rule (the refactor changed no answer for a store''s own users)');
select is((select count(*)::int from _par
            where int_isa is distinct from self_isa or int_isa is distinct from plat_isa
               or int_isa is distinct from old_isa), 0,
  'PA4 _is_store_admin_for = is_store_admin (self, platform) = 029''s rule');
select ok((select bool_or(int_rc) and not bool_and(int_rc) from _par),
  'PA5 the parity set holds both answers (it is not all-false or all-true)');
select ok(not public._resolve_can_for('lab.edit', u('13'), s_a())
          and public._resolve_can_for('notes.create', u('13'), s_a()),
  'PA6 the View rule recurses inside the store: lab.edit without lab.view is false, notes.create with notes.view is true');
select is((select count(*)::int from _codes c where public._resolve_can_for(c.c, u('11'), s_b())), 0,
  'PA7 _resolve_can_for answers only for the named store (A''s owner has nothing in B)');
select ok(not public._is_store_admin_for(u('11'), s_b()) and public._is_store_admin_for(u('11'), s_a()),
  'PA8 _is_store_admin_for answers only for the named store');
select _as(u('31'));
select ok(not public._resolve_can_for('settings.edit', u('31'), s_a())
          and not public._is_store_admin_for(u('31'), s_a()),
  'PA9 the internals have no platform-admin branch');
select _as(null);
select is((select count(*)::int from _codes c
            where public._resolve_can_for(c.c, u('14'), s_a())
               or public._resolve_can_for(c.c, u('15'), s_a())
               or public._resolve_can_for(c.c, u('16'), s_a())), 0,
  'PA10 an inactive user, a user without a role and a user holding another store''s role get nothing');

-- ===== I: the internals are not for clients ================================
select ok(not has_function_privilege('anon', 'public._resolve_can_for(text, uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public._is_store_admin_for(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public._z_report(uuid, timestamptz, timestamptz)', 'execute'),
  'I1 anon cannot execute _resolve_can_for, _is_store_admin_for or _z_report');
select ok(not has_function_privilege('authenticated', 'public._resolve_can_for(text, uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public._is_store_admin_for(uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public._z_report(uuid, timestamptz, timestamptz)', 'execute'),
  'I2 authenticated cannot execute them either');
set role authenticated; select _as(u('11'));
select throws_ok($$ select public._resolve_can_for('settings.edit', u('21'), s_b()) $$, '42501', null,
  'I3 a signed-in call to _resolve_can_for is refused');
select throws_ok($$ select * from public._z_report(s_b(), null, null) $$, '42501', null,
  'I4 a signed-in call to _z_report is refused');
reset role;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('_resolve_can_for', '_is_store_admin_for', '_z_report')
              and p.prosecdef and p.provolatile = 's'
              and 'search_path=public' = any(p.proconfig)), 3,
  'I5 the three internals are STABLE SECURITY DEFINER with search_path=public');
select ok(not has_function_privilege('anon', 'public._repoint_actor_keys()', 'execute')
          and not has_function_privilege('authenticated', 'public._repoint_actor_keys()', 'execute')
          and not has_function_privilege('service_role', 'public._repoint_actor_keys()', 'execute')
          and not (select prosecdef from pg_proc where oid = 'public._repoint_actor_keys()'::regprocedure),
  'I6 _repoint_actor_keys (the paste''s DDL) is not SECURITY DEFINER and no client role may run it');

-- ===== Z: z_report over _z_report, on the 023 fixture =====================
insert into auth.users (id, email) values ('32000000-0000-4000-8000-000000000051', 'z@t32');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('32000000-0000-4000-8000-000000000051', 'z_32', '-', s_a(), '32000000-0000-4000-8000-0000000000a2', true);
insert into public.customers (id, name, phone, store_id) values
  ('32000000-0000-4000-8000-000000000061', 'Ziad32', '01000032061', s_a());
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, lab_status, kind, store_id)
values
  ('32000000-0000-4000-8000-000000000071', 'Z32-1', u('61'), 1000, 0, 1000, 1000, '2026-09-20 10:00:00+00', 'Ready', 'sale', s_a()),
  ('32000000-0000-4000-8000-000000000072', 'Z32-2', u('61'), 1000, 0, 1000, 1000, '2026-09-20 11:00:00+00', 'Not Started', 'sale', s_a()),
  ('32000000-0000-4000-8000-000000000073', 'Z32-3', u('61'),  900, 0,  900,  900, '2026-09-20 12:00:00+00', 'Not Started', 'sale', s_a()),
  ('32000000-0000-4000-8000-000000000074', 'Z32-4', u('61'),    0, 0,    0,    0, '2026-09-20 13:00:00+00', 'Not Started', 'prescription', s_a()),
  ('32000000-0000-4000-8000-000000000075', 'Z32-R', null,    7777, 0, 7777, 7777, '2026-09-20 10:00:00+00', 'Ready', 'sale', s_b()),
  -- outside the Z window: an open invoice for the M checks below
  ('32000000-0000-4000-8000-000000000076', 'Z32-M', u('61'), 100, 0,  100,    0, '2026-01-01 10:00:00+00', 'Ready', 'sale', s_a());
update public.sales set voided_at = '2026-09-20 12:30:00+00', void_reason = 'gate' where id = u('73');
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, store_id) values
  (u('71'), 1000, 'cash',   'payment', '2026-09-20 10:00:00+00', s_a()),
  (u('72'),  500, 'cash',   'payment', '2026-09-20 11:00:00+00', s_a()),
  (u('72'),  500, 'wallet', 'payment', '2026-09-20 11:00:00+00', s_a()),
  (u('72'), -400, 'cash',   'refund',  '2026-09-20 11:30:00+00', s_a()),
  (u('73'),  900, 'cash',   'payment', '2026-09-20 12:00:00+00', s_a()),
  (u('73'), -900, 'cash',   'refund',  '2026-09-20 12:30:00+00', s_a()),
  (u('75'), 7777, 'cash',   'payment', '2026-09-20 10:00:00+00', s_b());
-- Two statements: 019's trigger stamps now() on the status change itself.
update public.sales set lab_status = 'Received' where id = u('74');
update public.sales set lab_status_changed_at = '2026-09-20 15:00:00+00' where id = u('74');

create table _z (k text primary key, j jsonb);
grant all on _z to authenticated;
create function _zf() returns timestamptz language sql stable as $$ select from_at from public.store_day_range('2026-09-20'::date) $$;
create function _zt() returns timestamptz language sql stable as $$ select to_at   from public.store_day_range('2026-09-20'::date) $$;

set role authenticated; select _as(u('51'));
insert into _z select 'wrapper', to_jsonb(z) from public.z_report(_zf(), _zt()) z;
reset role;
insert into _z select 'inner', to_jsonb(z) from public._z_report(s_a(), _zf(), _zt()) z;
insert into _z select 'rival', to_jsonb(z) from public._z_report(s_b(), _zf(), _zt()) z;

select is((select j from _z where k = 'wrapper'), (select j from _z where k = 'inner'),
  'Z1 z_report (as the store''s cashier) equals _z_report for that store and window');
select is((select j from _z where k = 'wrapper'),
  '{"expected_cash": 1100, "expected_by_tender": {"cash": 1100, "wallet": 500}, "expected_total": 1600,
    "order_count": 3, "prescription_count": 1, "void_count": 1, "refund_total": 1300, "lab_delivered": 1}'::jsonb,
  'Z2 ...and both give 023''s figures (net cash, void cancels, prescription not an order, rival unseen)');
select is((select (j->>'expected_cash')::numeric from _z where k = 'rival'), 7777::numeric,
  'Z3 _z_report reads a NAMED store with no JWT (the rival''s 7,777)');
select is(pg_get_function_result('public.z_report(timestamptz, timestamptz)'::regprocedure),
  'TABLE(expected_cash numeric, expected_by_tender jsonb, expected_total numeric, order_count bigint, prescription_count bigint, void_count bigint, refund_total numeric, lab_delivered bigint)',
  'Z4 z_report keeps its result type');
set role authenticated; select _as(u('41'));
select is((select count(*)::int || '/' || coalesce(sum(expected_total), -1)::text from public.z_report(_zf(), _zt())), '1/0',
  'Z5 a caller with no store still gets one all-zero row, as before');
reset role;

-- ===== T: tender_key =======================================================
create table _tk (m text, want text);
insert into _tk values
  ('Cash ', 'cash'), (' INSTAPAY', 'instapay'), ('', 'cash'), (null, 'cash'),
  ('cash + instapay', 'cash + instapay'),
  (E'\tcash', E'\tcash'),                         -- a tab is not trimmed
  (chr(160) || 'Cash', chr(160) || 'cash');       -- nor is a non-breaking space
select is((select count(*)::int from _tk), 7, 'T1 the shared tender table has its seven rows');
select is((select coalesce(string_agg(coalesce(quote_literal(m), 'NULL') || ' -> ' || coalesce(public.tender_key(m), 'NULL'), '; '), '')
             from _tk where public.tender_key(m) is distinct from want), '',
  'T2 tender_key gives the shared table''s answer for every row');
select is((select provolatile::text from pg_proc where oid = 'public.tender_key(text)'::regprocedure), 'i',
  'T3 tender_key is IMMUTABLE');

-- ===== M: actor columns reference staff ====================================
select is((select count(*)::int from pg_constraint c
            where c.contype = 'f' and c.confrelid = 'public.users'::regclass
              and c.confdeltype = 'n' and c.convalidated
              and (c.conrelid, c.conname) in (
                ('public.sale_payments'::regclass, 'sale_payments_recorded_by_staff_fkey'),
                ('public.sales'::regclass,         'sales_voided_by_staff_fkey'),
                ('public.shift_closes'::regclass,  'shift_closes_closed_by_staff_fkey'))), 3,
  'M1 recorded_by, voided_by and closed_by reference public.users ON DELETE SET NULL, validated');
select is((select count(*)::int from pg_constraint c
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
              and (c.conrelid, a.attname) in (('public.sale_payments'::regclass, 'recorded_by'),
                                              ('public.sales'::regclass, 'voided_by'),
                                              ('public.shift_closes'::regclass, 'closed_by'))), 0,
  'M2 no foreign key on those columns references auth.users any more');
select is((select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
             join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            where d.adrelid = 'public.sale_payments'::regclass and a.attname = 'recorded_by'),
  'auth.uid()', 'M3 recorded_by still defaults to auth.uid()');
select throws_ok($$ insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by)
                    values (u('76'), 1, 'cash', 'payment', s_a(), u('41')) $$,
  '23503', null, 'M4 a recorded_by that is a sign-in but not staff fails 23503');
select _as(u('41'));
select throws_ok($$ insert into public.sale_payments (sale_id, amount, method, kind, store_id)
                    values (u('76'), 1, 'cash', 'payment', s_a()) $$,
  '23503', null, 'M5 a forgotten actor under a non-staff JWT fails loudly via the default');
select _as(null);
select lives_ok($$ insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by)
                   values (u('76'), 1, 'cash', 'payment', s_a(), u('11')) $$,
  'M6 a staff recorded_by is accepted');
select throws_ok($$ update public.sales set voided_by = u('41') where id = u('73') $$,
  '23503', null, 'M7 a voided_by that is not staff fails 23503');
select throws_ok($$ insert into public.shift_closes (store_id, closed_by, from_at, to_at, counted_cash,
                                                     expected_cash, expected_total, variance)
                    values (s_a(), u('41'), '2026-01-01', '2026-01-02', 0, 0, 0, 0) $$,
  '23503', null, 'M8 a closed_by that is not staff fails 23503');

-- ===== S: sale_payments.store_id ===========================================
select ok((select attnotnull from pg_attribute
            where attrelid = 'public.sale_payments'::regclass and attname = 'store_id'),
  'S1 sale_payments.store_id is NOT NULL');
select throws_ok($$ insert into public.sale_payments (sale_id, amount, method, kind)
                    values (u('76'), 1, 'cash', 'payment') $$,
  '23502', null, 'S2 a ledger row with no store (no JWT to fill it) is refused');

-- ===== ST: settings ========================================================
select is((select count(*)::int from pg_constraint c
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.conrelid = 'public.settings'::regclass and c.contype = 'u'
              and array_length(c.conkey, 1) = 1 and a.attname = 'key'), 0,
  'ST1 the global settings key (settings_key_key) is gone');
select lives_ok($$ insert into public.settings (key, value, store_id) values
                   ('k032', 'a', s_a()), ('k032', 'b', s_b()) $$,
  'ST2 two stores may hold the same setting key');
select throws_ok($$ insert into public.settings (key, value, store_id) values ('k032', 'again', s_a()) $$,
  '23505', null, 'ST3 one store may not repeat a key');

-- ===== W: weighted cost ====================================================
-- w1: cost 9, empty; delivery 10 @ 4 then 10 @ 6.  w2: cost 5, shelf at -2;
-- delivery 3 @ 7.  w3: empty; ONE purchase with 10 @ 4 and 10 @ 6.
insert into public.inventory (id, name, category, sale_price, cost_price, store_id) values
  ('32000000-0000-4000-8000-000000000081', 'W32 one',   'Frame', 100, 9, s_a()),
  ('32000000-0000-4000-8000-000000000082', 'W32 two',   'Frame', 100, 5, s_a()),
  ('32000000-0000-4000-8000-000000000083', 'W32 three', 'Frame', 100, 0, s_a());
insert into public.stock_movements (product_id, qty, type, store_id) values (u('82'), -2, 'sale', s_a());
insert into public.purchases (id, supplier_id, total_amount, amount_paid, store_id) values
  ('32000000-0000-4000-8000-000000000091', null, 40, 0, s_a()),
  ('32000000-0000-4000-8000-000000000092', null, 60, 0, s_a()),
  ('32000000-0000-4000-8000-000000000093', null, 21, 0, s_a()),
  ('32000000-0000-4000-8000-000000000094', null, 100, 0, s_a());
insert into public.purchase_items (id, purchase_id, product_id, qty, unit_cost, total_cost, store_id) values
  ('32000000-0000-4000-8000-0000000000c1', u('91'), u('81'), 10, 4, 40, s_a()),
  ('32000000-0000-4000-8000-0000000000c2', u('92'), u('81'), 10, 6, 60, s_a()),
  ('32000000-0000-4000-8000-0000000000c3', u('93'), u('82'),  3, 7, 21, s_a()),
  ('32000000-0000-4000-8000-0000000000c4', u('94'), u('83'), 10, 4, 40, s_a());
-- The loop order of two lines in one purchase is not fixed; the average of
-- 10 @ 4 and 10 @ 6 is 5.00 whichever goes first.
insert into public.purchase_items (id, purchase_id, product_id, qty, unit_cost, total_cost, store_id) values
  ('32000000-0000-4000-8000-0000000000c5', u('94'), u('83'), 10, 6, 60, s_a());

set role authenticated; select _as(u('11'));
select public.receive_purchase(u('91'));
select is((select cost_price from public.inventory where id = u('81')), 4.00::numeric,
  'W1 onto an empty shelf the cost becomes the delivery''s cost (4, not the old 9)');
select public.receive_purchase(u('92'));
select is((select cost_price from public.inventory where id = u('81')), 5.00::numeric,
  'W2 10 @ 4 then 10 @ 6 is the weighted average 5.00 (was 4.67)');
select is((select stock_qty from public.inventory where id = u('81'))::int, 20,
  'W3 ...and the stock is 20');
select public.receive_purchase(u('93'));
select ok((select cost_price = 7 and stock_qty = 1 from public.inventory where id = u('82')),
  'W4 onto a NEGATIVE shelf (-2) the cost becomes the delivery''s cost (7) and stock is 1');
select public.receive_purchase(u('94'));
select is((select cost_price from public.inventory where id = u('83')), 5.00::numeric,
  'W5 two lines of one product in one purchase (10 @ 4, 10 @ 6) also average to 5.00');
reset role;

-- ===== MP: the paste on a database that still has orphans =================
-- Put the touched columns back as 031 left them: the auth.users keys (names
-- generated, as in production), no staff keys, store_id nullable.
alter table public.sale_payments drop constraint sale_payments_recorded_by_staff_fkey;
alter table public.sales         drop constraint sales_voided_by_staff_fkey;
alter table public.shift_closes  drop constraint shift_closes_closed_by_staff_fkey;
alter table public.sale_payments add foreign key (recorded_by) references auth.users(id) on delete set null;
alter table public.sales         add foreign key (voided_by)   references auth.users(id) on delete set null;
alter table public.shift_closes  add foreign key (closed_by)   references auth.users(id) on delete set null;
alter table public.sale_payments alter column store_id drop not null;

-- A sale voided by x1 (a sign-in, not staff) with TWO ledger rows that have
-- no store (written with no JWT) and were recorded by x1 too. All rows are
-- written in this transaction, so any update of them re-runs their keys -
-- the exact state that made 032's first draft abort.
select _as(null);
insert into public.sales (id, invoice_no, customer_id, total_amount, discount,
                          net_amount, amount_paid, order_date, lab_status, kind, store_id)
values ('32000000-0000-4000-8000-000000000077', 'MP32-1', u('61'), 100, 0, 100, 0,
        '2026-02-01 10:00:00+00', 'Ready', 'sale', s_a());
insert into public.sale_payments (sale_id, amount, method, kind, paid_at, recorded_by) values
  (u('77'), 50, 'cash',   'payment', '2026-02-01 10:00:00+00', u('41')),
  (u('77'), 50, 'wallet', 'payment', '2026-02-01 10:05:00+00', u('41'));
update public.sales set voided_at = '2026-02-01 11:00:00+00', void_reason = 'gate', voided_by = u('41')
 where id = u('77');
create table _mp (k text primary key, v text);
insert into _mp select 'ctid', ctid::text from public.sales where id = u('77');
insert into _mp select 'nulls', count(*)::text from public.sale_payments where sale_id = u('77') and store_id is null;

select lives_ok($$ select public._repoint_actor_keys() $$,
  'MP1 the paste''s step survives two NULL-store payments (non-staff recorded_by) on a sale voided by a non-staff id');
select ok((select v from _mp where k = 'nulls') = '2'
          and (select count(*) from public.sale_payments where sale_id = u('77') and store_id = s_a()) = 2
          and (select attnotnull from pg_attribute
                where attrelid = 'public.sale_payments'::regclass and attname = 'store_id'),
  'MP2 both NULL-store rows were backfilled from their sale and store_id is NOT NULL again');
select is((select ctid::text from public.sales where id = u('77')), (select v from _mp where k = 'ctid'),
  'MP3 the backfill did not touch the sales row (no sync re-update, so no re-check of its keys or CHECKs)');
select is((select string_agg(c.conname || '=' || c.convalidated::text, ', ' order by c.conname)
             from pg_constraint c
            where c.contype = 'f' and c.confrelid = 'public.users'::regclass and c.confdeltype = 'n'
              and c.conname in ('sale_payments_recorded_by_staff_fkey', 'sales_voided_by_staff_fkey',
                                'shift_closes_closed_by_staff_fkey')),
  'sale_payments_recorded_by_staff_fkey=false, sales_voided_by_staff_fkey=false, shift_closes_closed_by_staff_fkey=true',
  'MP4 the orphaned keys are added NOT VALID (warned, not aborted); the clean one is validated');
select is((select count(*)::int from pg_constraint c
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
              and (c.conrelid, a.attname) in (('public.sale_payments'::regclass, 'recorded_by'),
                                              ('public.sales'::regclass, 'voided_by'),
                                              ('public.shift_closes'::regclass, 'closed_by'))), 0,
  'MP5 the old auth.users keys (generated names) were found by column and dropped');
select is((select tgenabled::text from pg_trigger
            where tgrelid = 'public.sale_payments'::regclass and tgname = 'sale_payments_sync'), 'O',
  'MP6 sale_payments_sync is enabled again after the backfill');
-- The sale first: a payment update re-updates the sale, which re-checks
-- its (still orphaned) voided_by - the 'checked again on its next update'
-- the warning names.
update public.sales set voided_by = null where id = u('77');
update public.sale_payments set recorded_by = null where sale_id = u('77');
select public._repoint_actor_keys();
select ok((select (select count(*) from public.sale_payments where sale_id = u('77') and store_id = s_a()) = 2
                  and amount_paid = 100 from public.sales where id = u('77'))
          and (select bool_and(c.convalidated) and count(*) = 3 from pg_constraint c
                where c.conname in ('sale_payments_recorded_by_staff_fkey', 'sales_voided_by_staff_fkey',
                                    'shift_closes_closed_by_staff_fkey')),
  'MP7 once the orphans are fixed, re-running _repoint_actor_keys validates all three keys');

-- ===== V: stamp ============================================================
select ok(exists (select 1 from public.lensy_schema_versions where version = 32),
  'V1 032 stamped itself');

rollback;
