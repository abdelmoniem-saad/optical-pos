-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`, so
-- every change it makes is undone before the last line - but it also needs
-- pgTAP and it asserts against a schema built by web/scripts/test-db.sh.
-- To verify a migration on a real project, paste the MIGRATION file
-- (web/supabase/0NN_*.sql) and check the query SETUP.md gives you.
-- ============================================================-- LensyPOS — Phase 3 gate: 014_server_rbac_test.sql (pgTAP)
-- ============================================================
-- Proves PHASED_ROADMAP §6: authority leaves the browser.
--   G-S  store resolution cannot be hijacked by another user's username
--   G-R  the three RBAC tables stop being world-writable, and stop
--        leaking one store's role matrix into another
--   G-C  resolve_can() mirrors the app's rule, and require_perm() raises
--   G-X  the SQL and the TypeScript DELIBERATELY differ for an
--        unprovisioned account, and that difference is asserted, not hoped
--
-- Everything runs inside ONE transaction and ROLLS BACK. Runs as
-- `authenticated` with a JWT claim set, so RLS and the security-definer
-- functions are exercised for real.
--
-- RED-HARNESS NOTE: written so it still RUNS against a database with no 014.
-- Behavioural probes go through plpgsql helpers that capture the exception
-- instead of aborting the TAP stream; structural probes read the catalogs.
--
-- Run: bash web/scripts/test-db.sh   (CI does this on every push)

begin;
create extension if not exists pgtap;
select plan(33);

-- ===== fixtures ============================================================
-- Two stores, so every tenant assertion has something to fail against.
-- 008 auto-creates 'Main Store' (A) and licenses it; we add B by hand and
-- license it too, because license_write_ok() gates every write policy.

create function _store_a() returns uuid
language sql stable as $$ select id from public.stores order by created_at limit 1 $$;

insert into public.stores (id, name)
values ('cccccccc-cccc-4ccc-8ccc-00000000000b', 'Store B')
on conflict (id) do nothing;

create function _store_b() returns uuid
language sql stable as $$ select 'cccccccc-cccc-4ccc-8ccc-00000000000b'::uuid $$;

insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (_store_b(), 'STORE-TESTB', 'pro', null)
on conflict (store_id) do nothing;

-- Positions. `name` is globally unique (roles_name_key), so store B's seller
-- BYPASS roles in resolve_can, so the manager's position is deliberately named
-- scenario below has to be built from `users.username`, not role names.
insert into public.roles (id, name, store_id) values
  ('dddddddd-dddd-4ddd-8ddd-000000000001', 'owner',  _store_a()),
  ('dddddddd-dddd-4ddd-8ddd-000000000002', 'supervisor', _store_a()),
  ('dddddddd-dddd-4ddd-8ddd-000000000003', 'seller', _store_a()),
  ('dddddddd-dddd-4ddd-8ddd-000000000004', 'seller-b', _store_b())
on conflict (id) do nothing;

insert into auth.users (id, email, username) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier@lensypos.local',  'cashier'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'manager@lensypos.local',  'manager'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000003', 'boss@lensypos.local',     'boss'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000004', 'norole@lensypos.local',   'norole'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000005', 'buser@lensypos.local',    'buser'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000006', 'root@lensypos.local',     'root'),
  -- The store-resolution hole, in the form the schema actually allows.
  --
  -- The roadmap's original T8 scenario - two stores both containing a user
  -- called admin - is IMPOSSIBLE here: public.users.username carries a global
  -- UNIQUE constraint (users_username_key), so duplicates cannot exist. Good.
  --
  -- What IS real, and arguably worse: the fallback matches the caller's EMAIL
  -- LOCAL PART against users.username. So an auth identity with no public.users
  -- row of its own - unprovisioned, or created straight in the Supabase
  -- dashboard - whose local part happens to equal SOMEONE ELSE's username
  -- silently inherits that person's store, and with it their role and licence.
  -- Two identities below do exactly that:
  --   ...0009 IS a staff row in store A, but its email local part is buser,
  --         which is a real user in store B  -> must resolve to A (id wins)
  --   ...000a has NO staff row, local part buser -> must resolve to NOBODY
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 'buser@lensypos.local',  'imposter'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-00000000000a', 'buser@stranger.local', 'stranger')
on conflict (id) do nothing;

insert into public.users (id, username, password_hash, full_name, role_id, store_id, is_active)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier', '-', 'Cashier A',
     'dddddddd-dddd-4ddd-8ddd-000000000003', _store_a(), true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'manager', '-', 'Manager A',
     'dddddddd-dddd-4ddd-8ddd-000000000002', _store_a(), true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000003', 'boss',    '-', 'Boss A',
     'dddddddd-dddd-4ddd-8ddd-000000000001', _store_a(), true),
  -- no position at all: the app calls this openAccess and grants everything
  -- so a login is never bricked over bookkeeping. The database must NOT copy
  -- that leniency - G-X asserts the gap is deliberate.
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000004', 'norole',  '-', 'No Role', null, _store_a(), true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000005', 'buser',   '-', 'Cashier B',
     'dddddddd-dddd-4ddd-8ddd-000000000004', _store_b(), true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000006', 'root',    '-', 'Vendor',   null, _store_a(), true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 'imposter', '-', 'Imposter', null, _store_a(), true)

on conflict (id) do nothing;

insert into public.platform_admins (auth_uid, name)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000006', 'Vendor')
on conflict (auth_uid) do nothing;

-- Grants: the seller position gets exactly two codes; the manager gets the
-- staff-management code the policies will require.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.id = 'dddddddd-dddd-4ddd-8ddd-000000000003'
   and p.code in ('history.view', 'history.edit')
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r, public.permissions p
 where r.id = 'dddddddd-dddd-4ddd-8ddd-000000000002'
   and p.code in ('history.view', 'history.edit', 'staff.edit', 'staff.create')
on conflict (role_id, permission_id) do nothing;

-- Per-person overrides: the manager is explicitly DENIED the void they hold
-- through their position, and explicitly ALLOWED a code their position lacks.
insert into public.user_permissions (user_id, permission_id, allow)
select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', p.id, v.allow
  from public.permissions p
 cross join (values ('history.edit', false), ('reports.view', true)) as v(code, allow)
 where p.code = v.code
on conflict (user_id, permission_id) do nothing;

-- ===== capture helpers =====================================================
-- One row per probe so a rejected statement cannot abort the TAP stream.

create table _cap (k text primary key, ok boolean, note text);
grant all on _cap to authenticated;

-- Attempt a statement, record whether it was refused.
create function _try(p_k text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  insert into _cap (k, ok) values (p_k, true);
exception when others then
  insert into _cap (k, ok, note) values (p_k, false, sqlerrm);
end $$;

-- Count the rows a SELECT as `authenticated` can actually see.
create function _visible(p_sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute p_sql into n;
  return n;
exception when others then
  return -1;
end $$;

create function _cap_ok(p_k text) returns boolean
language sql stable as $$ select ok from _cap where k = p_k $$;

create function _cap_note(p_k text) returns text
language sql stable as $$ select note from _cap where k = p_k $$;

-- Impersonate an auth identity for the rest of the transaction.
create function _as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, false);
end $$;

-- ===== structure ===========================================================
-- 4-argument pgTAP form: the 3-argument one takes a BARE table name, so
-- 'public.roles' would be looked up as a table literally called that.

select has_function('public', 'resolve_can', array['text','uuid'],
  'S1 resolve_can(code, user) exists - the SQL mirror of resolveCan()');
select has_function('public', 'require_perm', array['text'],
  'S2 require_perm(code) exists - the guard privileged RPCs call');
select has_table('public', 'audit_log',
  'S3 audit_log exists, so this phase''s own changes are reviewable');

-- The RBAC tables must no longer carry the blanket write policy.
select is((select count(*) from pg_policies
            where schemaname = 'public' and tablename = 'permissions'
              and policyname = 'lensy_authenticated_all'), 0::bigint,
  'S4 the world-writable policy on permissions is gone');
-- =========================================================================
-- G-S: store resolution cannot be hijacked (threat T8, in its real form)
-- =========================================================================
-- 008's auth_store_id() is where u.id = auth.uid() or u.username =
-- <email local part> limit 1 with NO ordering. Because users.username is
-- globally unique the duplicate case cannot occur, but the OR still does: an
-- identity with no staff row of its own is matched against OTHER people's
-- usernames, and limit 1 then hands it their store - and with it their role,
-- their data and their licence.

set role authenticated;

-- S1a the ordinary case still works: the id match wins.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid);
select is(public.auth_store_id(), _store_a(),
  'G-S1 a cashier resolves to their own store by auth id');

-- S1b THE HOLE: this identity IS a staff row in store A, but its email local
-- part is buser - a real user in store B. Before 014 the unordered or could
-- hand back store B instead.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000009'::uuid);
select is(public.auth_store_id(), _store_a(),
  'G-S2 a staff row wins over another user''s matching username (id beats the fallback)');

-- S1c the same hole with no staff row at all: before 014 this identity was
-- dropped into store B by matching buser's username, and could read and write
-- another tenant's entire shop.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-00000000000a'::uuid);
select is(public.auth_store_id(), null,
  'G-S3 an unprovisioned identity matching someone else''s username resolves to NO store');

-- S1d and a username that matches nothing stays unresolved.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff'::uuid);
select is(public.auth_store_id(), null,
  'G-S4 an unknown identity resolves to no store');
-- =========================================================================
-- G-R: the RBAC tables stop being world-writable, and stop leaking (T7)
-- =========================================================================
-- Before 014: `permissions` is `for all ... using (true) with check (true)`
-- and role_permissions / user_permissions keep 001's blanket policy, so ANY
-- signed-in cashier can insert a row granting themselves anything.

-- The cashier (seller: history.view + history.edit only).
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid);

-- Reading the catalogue must still work: the Staff matrix needs the code
-- list to render, and locking that out would break the screen for everyone.
select ok((select count(*) from public.permissions) > 0,
  'G-R1 the permission catalogue is still readable by staff (the matrix needs it)');

-- The write probes below are PLAIN statements whose effect is measured, not
-- dynamic SQL wrapped in a try/catch. The first version used _try()/_visible(),
-- which run through plpgsql EXECUTE, and every 'must be denied' probe came back
-- ALLOWED - the helper was not seeing the RLS decision the way a real client
-- does. The Phase 1 and Phase 2 gates already assert this way; this one now
-- matches them, so a denial is proven by the row NOT changing rather than by an
-- exception that never arrives.

-- ...but nobody may rewrite it.
-- A denied write RAISES (SQLSTATE 42501), and ON_ERROR_STOP would abort the
-- whole file - so each probe runs in a DO block. A DO block is a plain
-- statement, not dynamic SQL, so RLS is evaluated exactly as it is for a real
-- client; only the exception is swallowed. The effect is then measured.
do $$ begin
  insert into public.permissions (code) values ('evil.backdoor');
exception when others then null;
end $$;
select is((select count(*) from public.permissions where code = 'evil.backdoor')::bigint, 0::bigint,
  'G-R2 a cashier cannot INSERT a permission code');

do $$ begin
  update public.permissions set name = 'pwned' where code = 'settings.delete';
exception when others then null;
end $$;
select is((select count(*) from public.permissions where code = 'settings.delete' and name = 'pwned')::bigint, 0::bigint,
  'G-R3 a cashier cannot UPDATE the permission catalogue');

do $$ begin
  insert into public.role_permissions (role_id, permission_id)
  select 'dddddddd-dddd-4ddd-8ddd-000000000003'::uuid, id
    from public.permissions where code = 'settings.delete';
exception when others then null;
end $$;
select is((select count(*) from public.role_permissions rp
            join public.permissions p on p.id = rp.permission_id
           where rp.role_id = 'dddddddd-dddd-4ddd-8ddd-000000000003'
             and p.code = 'settings.delete')::bigint, 0::bigint,
  'G-R4 a cashier cannot grant themselves a code through role_permissions');

do $$ begin
  insert into public.user_permissions (user_id, permission_id, allow)
  select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid, id, true
    from public.permissions where code = 'settings.delete';
exception when others then null;
end $$;
select is((select count(*) from public.user_permissions up
            join public.permissions p on p.id = up.permission_id
           where up.user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
             and p.code = 'settings.delete')::bigint, 0::bigint,
  'G-R5 a cashier cannot grant themselves an override through user_permissions');

do $$ begin
  delete from public.role_permissions
   where role_id = 'dddddddd-dddd-4ddd-8ddd-000000000002';
exception when others then null;
end $$;
select is((select count(*) from public.role_permissions
            where role_id = 'dddddddd-dddd-4ddd-8ddd-000000000002')::bigint, 4::bigint,
  'G-R6 a cashier cannot DELETE grants (the supervisor''s four survive)');

-- Cross-store visibility. Asserted as 'zero rows from the other store' rather
-- than a magic total, because 004 seeds its own roles and grants and those
-- counts are not ours to predict.
select is((select count(*) from public.roles where store_id = _store_b())::bigint, 0::bigint,
  'G-R7 store A staff cannot see store B''s roles');
select ok((select count(*) from public.roles where store_id = _store_a()) > 0,
  'G-R7b ...while their own store''s roles are visible');

select is((select count(*) from public.role_permissions rp
            join public.roles r on r.id = rp.role_id
           where r.store_id <> _store_a())::bigint, 0::bigint,
  'G-R8 no role grant from another store is readable');
select ok((select count(*) from public.role_permissions rp
            join public.roles r on r.id = rp.role_id
           where r.store_id = _store_a()) > 0,
  'G-R8b ...while their own store''s grants are readable');
-- =========================================================================
-- G-C: resolve_can() mirrors the app's rule; require_perm() raises
-- =========================================================================
-- The TSX rule (permissions.tsx) is: an explicit per-person override ALWAYS
-- wins (allow OR deny), otherwise the answer is exactly what the position
-- grants. Admin/owner positions and the `superadmin` username bypass. These
-- assertions use the SAME fixtures as web/src/data/permissions.test.ts, so
-- "the SQL and the TypeScript agree" is proven rather than assumed.

-- Cashier: seller holds history.view + history.edit, nothing else.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid);
select is(public.resolve_can('history.view'), true,
  'G-C1 a granted code is allowed');
select is(public.resolve_can('settings.delete'), false,
  'G-C2 a code the position does not hold is refused');

-- Manager: position grants history.edit, but an explicit DENY overrides it.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000002'::uuid);
select is(public.resolve_can('history.edit'), false,
  'G-C3 an explicit deny beats a position grant');
-- ...and an explicit ALLOW beats a missing grant.
select is(public.resolve_can('reports.view'), true,
  'G-C4 an explicit allow beats a missing position grant');
select is(public.resolve_can('history.view'), true,
  'G-C5 a code with no override falls through to the position grant');

-- Owner position bypasses everything.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000003'::uuid);
select is(public.resolve_can('settings.delete'), true,
  'G-C6 the owner position bypasses the matrix');
select is(public.resolve_can('anything.at.all'), true,
  'G-C7 the owner position bypasses codes that do not even exist');

-- Vendor (platform admin) bypasses everything.
select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000006'::uuid);
select is(public.resolve_can('settings.delete'), true,
  'G-C8 a platform admin bypasses the matrix');

-- =========================================================================
-- G-X: the SQL and the app DELIBERATELY differ for an unprovisioned account
-- =========================================================================
-- permissions.tsx:268 grants EVERYTHING when an account has no staff row or
-- no position ("openAccess - never brick a login over bookkeeping"). That is
-- a reasonable UI stance and an unacceptable database stance: the browser's
-- job is to not lock someone out during a provisioning hiccup, the
-- database's job is to not trust an account nobody placed. So resolve_can()
-- says NO here, and these assertions exist so the divergence is a decision on
-- the record rather than a surprise discovered during an incident.

select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000004'::uuid);
select is(public.resolve_can('history.view'), false,
  'G-X1 an account with no position is refused by the DATABASE, even though the UI allows it');
select is(public.resolve_can('sales.delete'), false,
  'G-X2 ...for every code, not just the ungranted ones');

-- =========================================================================
-- G-P: require_perm() raises instead of returning false
-- =========================================================================
-- A silent false inside a SECURITY DEFINER function turns into a confusing
-- "permission denied for table sales" much later. require_perm names the code.

select _as('aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid);
select _try('p1', $q$select public.require_perm('settings.delete')$q$);
select is(_cap_ok('p1'), false,
  'G-P1 require_perm refuses a code the caller does not hold');
select matches(_cap_note('p1'), 'settings.delete',
  'G-P2 the error names the missing code, so the failure is diagnosable');

select _try('p2', $q$select public.require_perm('history.view')$q$);
select is(_cap_ok('p2'), true,
  'G-P3 require_perm passes silently for a held code');

-- The privileged RPCs must actually call it: a void is not a cashier's move.
select _try('p3', $q$select public.void_sale(
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid, 'probe', true)$q$);
select is(_cap_ok('p3'), false,
  'G-P4 void_sale refuses a caller without history.void (fails before anything is written)');
-- Not just "it failed": it must fail on PERMISSION. Before 014 this probe
-- fails for an unrelated reason (no such sale), which would let a broken
-- void_sale pass this gate.
select matches(_cap_note('p3'), 'insufficient permission|permission',
  'G-P5 void_sale refuses on a permission ground, named in the error');

rollback;
