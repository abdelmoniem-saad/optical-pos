-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 034 gate (offline-v2 Phase 1b, docs/offline-v2/design.md 3 and 4.4).
-- Store A is put on its register (r1, later r2 by a takeover); B is an
-- ordinary store whose ids a forger may try; C is a second register store
-- for the 2,000-op drain. The register is impersonated through
-- request.jwt.claim.sub (_shim.sql): register_ingest identifies it by
-- auth.uid() alone, so most calls run in the owner context with the
-- register's JWT; the first batch and the security probes run as the
-- authenticated role itself.
--
-- V   shape: the kind table lists every kind of design 3.6 and nothing
--     else, every kind names an existing writer with the contract signature
--     (23 writers), the money column is MONEY_KINDS, the log column is
--     LOG_KINDS + noop; grants (writers and internals closed to every
--     client role; ingest/ping/park open to authenticated, not anon).
-- L   my_license_state and license_feature answer exactly as 026/027 did,
--     now through _license_state/_license_feature_for.
-- Z   _store_day_range: the Cairo day, not the UTC day.
-- C   current:false and the other early answers before any op.
-- S   the first batch, through the authenticated role: ok, stamps, and
--     every lensy.* GUC and the ingest token cleared on return.
-- T   event times verbatim (t = now() - 7 days) on every row of an op;
--     audit_log via_register/event_at/actor; attribution = the op actor.
-- K   an ok test for every kind of this step.
-- F   each flag code of this step fires once, alone.
-- M   step 2's money and purchase writers: an ok test for each kind (one sale
--     through create, re-checkout with a total change - no 42501, money_write
--     left empty - collect, refund, header, exams, lab_status at t, void after
--     a partial refund), each writer flag alone (void_not_zero only with
--     void_derivation_differs, see M43), feature:lab at ingest level, the
--     shift.close recompute and z_mismatch, the purchase kinds, a STATE hold
--     for a missing target of every sale.* kind, payment.collect and
--     purchase.receive (and the voided / no-lab / received cases), and
--     attribution. The twin of the online RPCs is tests/034_ingest_twin_test.sql.
-- H   each hold class (MAL, INT, STATE, FAULT) and the transient retry; a
--     held op rolls back its own rows and keeps earlier ops; held_* cleared
--     by a successful retry; server_upgrade_required is not a hold.
-- P   the vendor park (register_resolve_held).
-- R   refusals: foreign_actor, no_session_sid, foreign_id, and a noop of
--     every MONEY_KINDS kind (money_skip_forbidden); the target untouched,
--     alert set, the queue continues.
-- D   dup, gap, dup_import.
-- B   the budget: 0 acks one op per call; a loop drains 2,000 note.upsert
--     ops to last_seq = 2000.
-- PG  register_ping: commands, licence piggyback, server_now, stamps.
-- Q   seq conflict quarantines; revoked; replaced (takeover, epoch).
-- X   the register JWT: create_sale_order refused, no table readable; no
--     NULL-store row; no row attributed to a register login.
-- Step 3 (after Q; ids v3('xx')):
-- V12-14 internals closed; the undo tables closed; zz_register_undo on the
--     guard's 25 tables.
-- ST  an ok test for each staff/RBAC kind, via_command applied (applied_seq).
-- F3  assign_admin, self_change, perm:staff.delete, max_staff,
--     reactivated_after_remote_deactivation, target_missing, each alone.
-- R3  protected_target (owner, register uid, cloud login), foreign_id
--     (product), foreign_actor, reserved_role (' admin ', Admin grant),
--     bad_command, reserved_name: target unchanged, alert set. H3 the
--     per-store username index (INT).
-- LC  the licence ends between two ops of one batch: applied and flagged.
-- U   the undo log (seq-keyed, cascades, gate only).
-- RV  the revert scenario of design 4.4/6.3: three forged ops, a seq
--     conflict, register_revert_ops -> every guarded table equals its
--     snapshot; register_ops_foreign; last_seq back; re-claim; the genuine
--     ops apply. Refused for non-platform callers and unquarantined stores.
-- FG  register_fill_gap. EO register_export_ops (owner only). EX the setup
--     exports and their window. PR prune (skeletons, undo by ingest time),
--     retention, undo_pruned.
begin;
create extension if not exists pgtap;
select plan(248);

-- ===== fixtures ============================================================
create function u(p text) returns uuid language sql immutable as $$
  select ('34000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function s_a() returns uuid language sql immutable as $$ select u('a0') $$;
create function s_b() returns uuid language sql immutable as $$ select u('b0') $$;
create function s_c() returns uuid language sql immutable as $$ select u('c0') $$;

create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), true);
  perform set_config('request.jwt.claims', case when p is null then '{}' else json_build_object('sub', p)::text end, true);
end $$;
create function _token(p_store uuid, p_open boolean) returns void language plpgsql as $$
begin
  perform public._register_bypass(p_store, 'admin', p_open);
  perform set_config('lensy.register_admin', case when p_open then p_store::text else '' end, true);
end $$;

create table _r (k text primary key, j jsonb);
grant all on _r to authenticated, service_role;

-- The envelope of one op (design 3.1). The sid defaults to the actor's open
-- session: owner A 5a, cashier A 5c, owner C 5d.
create function op(p_s bigint, p_k text, p_a uuid, p_p jsonb, p_t timestamptz default now(), p_sid uuid default null)
returns jsonb language sql volatile as $$
  select jsonb_build_object('s', p_s, 'i', gen_random_uuid(), 'k', p_k, 'v', 1, 'a', p_a,
           'sid', coalesce(p_sid, case p_a when u('11') then u('5a') when u('13') then u('5c')
                                           when u('31') then u('5d') end),
           't', to_jsonb(p_t), 'e', 1, 'p', p_p)
$$;
-- A's next seq (store_registers is closed to clients: read in owner context).
create function nx() returns bigint language sql stable security definer set search_path = public as $$
  select last_seq + 1 from public.store_registers where store_id = s_a() $$;
create function _ep() returns integer language sql stable as $$
  select coalesce(nullif(current_setting('test.epoch', true), '')::integer, 1) $$;
create function ing(p_ops jsonb) returns jsonb language sql as $$
  select public.register_ingest(_ep(), 1, 3, now() - interval '1 hour', p_ops) $$;
-- One op at A's next seq, its response kept under p_key with the seq and op.
create function one(p_key text, p_k text, p_a uuid, p_p jsonb, p_t timestamptz default now(),
                    p_sid uuid default null, p_extra jsonb default '{}') returns jsonb
language plpgsql as $$
declare
  v_s  bigint := nx();
  v_op jsonb := op(nx(), p_k, p_a, p_p, p_t, p_sid) || p_extra;
  v_r  jsonb;
begin
  v_r := ing(jsonb_build_array(v_op));
  insert into _r values (p_key, v_r || jsonb_build_object('_seq', v_s, '_op', v_op))
  on conflict (k) do update set j = excluded.j;
  return v_r;
end $$;
create function sq(p_key text) returns bigint language sql stable as $$
  select (j ->> '_seq')::bigint from _r where k = p_key $$;
create function st(p_key text) returns text language sql stable as $$
  select o.status from public.register_ops o where o.store_id = s_a() and o.seq = sq(p_key) $$;
create function vi(p_key text) returns text[] language sql stable as $$
  select o.violations from public.register_ops o where o.store_id = s_a() and o.seq = sq(p_key) $$;
create function rg() returns public.store_registers language sql stable as $$
  select * from public.store_registers where store_id = s_a() $$;

-- Stores, licences (valid since 2000, so t = now() - 7 days is inside them).
insert into public.stores (id, name) values
  (s_a(), 'Store A34'), (s_b(), 'Store B34'), (s_c(), 'Store C34');
insert into public.store_licenses (store_id, license_key, plan, starts_at, expires_at) values
  (s_a(), 'STORE-A34', 'pro', '2000-01-01', null),
  (s_b(), 'STORE-B34', 'pro', '2000-01-01', null),
  (s_c(), 'STORE-C34', 'pro', '2000-01-01', null);
insert into public.roles (id, name, store_id) values
  (u('a1'), 'Admin', s_a()), (u('a2'), 'Cashier34', s_a()),
  (u('b1'), 'Admin', s_b()), (u('c1'), 'Admin', s_c());
insert into public.role_permissions (role_id, permission_id)
select u('a2'), p.id from public.permissions p
 where p.code in ('pos.view', 'pos.create', 'customers.view', 'customers.create',
                  'notes.view', 'notes.create', 'inventory.view');
-- A: 11 owner (cloud), 13 cashier and 16 switched-off cashier (register-local).
-- B: 21 admin. C: 31 owner. 61 the vendor. 71/72 A's register logins, 73 C's.
insert into auth.users (id, email) values
  (u('11'), 'a1@t34'), (u('21'), 'b1@t34'), (u('31'), 'c1@t34'), (u('61'), 'p1@t34'),
  (u('71'), 'register.a.1@t34'), (u('72'), 'register.a.2@t34'), (u('73'), 'register.c.1@t34');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  (u('11'), 'owner_a34',   'supabase-auth',  s_a(), u('a1'), true),
  (u('13'), 'cashier_a34', 'register-local', s_a(), u('a2'), true),
  (u('16'), 'old_a34',     'register-local', s_a(), u('a2'), false),
  (u('21'), 'admin_b34',   'supabase-auth',  s_b(), u('b1'), true),
  (u('31'), 'owner_c34',   'supabase-auth',  s_c(), u('c1'), true);
insert into public.platform_admins (auth_uid) values (u('61'));
-- B's rows a forger may name; A's supplier with a purchase (STATE hold).
insert into public.customers (id, name, phone, store_id) values (u('9b'), 'Customer B34', '0134', s_b());
insert into public.suppliers (id, name, store_id) values (u('d1'), 'Supplier with purchases', s_a());
insert into public.purchases (id, supplier_id, total_amount, amount_paid, store_id) values (u('d2'), u('d1'), 10, 0, s_a());

-- 026's my_license_state and 027's license_feature, kept as the oracles.
create function _mls026() returns table (state text, plan text, starts_at timestamptz, expires_at timestamptz, store_name text)
language sql stable security definer set search_path = public as $$
  select case when s.id is null then 'none' when l.id is null then 'none' when l.is_revoked then 'expired'
              when l.starts_at > now() then 'pending'
              when l.expires_at is null or l.expires_at > now() then 'active'
              when l.expires_at > now() - interval '30 days' then 'grace' else 'expired' end,
         l.plan, l.starts_at, l.expires_at, s.name
    from public.stores s left join public.store_licenses l on l.store_id = s.id
   where s.id = public.auth_store_id()
$$;
create function _lf027(p_name text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select case when (l.features ->> p_name) = 'true' then true
                               when (l.features ->> p_name) = 'false' then false else true end
                     from public.store_licenses l where l.store_id = public.auth_store_id()), true)
$$;
-- Every licence shape, compared as the caller (store A's licence is changed
-- and put back). Returns the cases that differ.
create function _lic_cases() returns text language plpgsql as $$
declare
  c record;
  v_bad text := '';
begin
  for c in select * from (values
      ('active',  '2000-01-01'::timestamptz, null::timestamptz, false, '{}'::jsonb),
      ('pending', now() + interval '3 days', null, false, '{}'),
      ('grace',   '2000-01-01', now() - interval '3 days', false, '{"lab": false}'),
      ('expired', '2000-01-01', now() - interval '40 days', false, '{"lab": true}'),
      ('revoked', '2000-01-01', null, true, '{"lab": "yes"}')) as x(name, s, e, rv, f) loop
    update public.store_licenses set starts_at = c.s, expires_at = c.e, is_revoked = c.rv, features = c.f
     where store_id = s_a();
    if (select array_agg(m::text) from public.my_license_state() m) is distinct from
       (select array_agg(o::text) from _mls026() o) then
      v_bad := v_bad || c.name || ' ';
    end if;
    if public.license_feature('lab') is distinct from _lf027('lab')
       or public.license_feature('nothing') is distinct from _lf027('nothing') then
      v_bad := v_bad || c.name || '(feature) ';
    end if;
  end loop;
  update public.store_licenses set starts_at = '2000-01-01', expires_at = null, is_revoked = false, features = '{}'
   where store_id = s_a();
  return v_bad;
end $$;

-- ===== V: shape ============================================================
select is((select string_agg(kind, ',' order by kind) from public._register_kind_perms),
  'auth.lockout,clock.reset,credential.set,customer.delete,customer.upsert,metadata.delete,metadata.reorder,'
  'metadata.upsert,noop,note.delete,note.upsert,payment.collect,product.upsert,purchase.delete,'
  'purchase.payment.add,purchase.payment.delete,purchase.receive,purchase.upsert,role.create,'
  'role.set_permission,sale.create,sale.exams,sale.header,sale.lab_status,sale.recheckout,sale.refund,'
  'sale.void,session.end,session.start,setting.set,shift.close,staff.create,staff.set_access,'
  'staff.update_profile,stock.adjust,store.update,supplier.delete,supplier.upsert,user.set_permission',
  'V1 _register_kind_perms lists every kind of design 3.6 and nothing else');
select is((select coalesce(string_agg(kind, ','), '') from public._register_kind_perms
            where to_regprocedure(format('public.%I(uuid, uuid, timestamptz, jsonb, text)', writer)) is null),
  '', 'V2 every kind names an existing writer with the contract signature');
select is((select string_agg(distinct writer, ',' order by writer) from public._register_kind_perms),
  '_ingest_customer,_ingest_log,_ingest_metadata,_ingest_note,_ingest_payment_collect,_ingest_product,'
  '_ingest_purchase,_ingest_purchase_payment,_ingest_purchase_receive,_ingest_rbac,_ingest_sale_create,'
  '_ingest_sale_exams,_ingest_sale_header,_ingest_sale_lab_status,_ingest_sale_recheckout,'
  '_ingest_sale_refund,_ingest_sale_void,_ingest_settings,_ingest_shift_close,_ingest_staff_create,'
  '_ingest_staff_update,_ingest_stock_adjust,_ingest_supplier',
  'V3 the 23 writers of design 4.4, one per row of the 3.6 table');
-- MONEY_KINDS of design 3.6 (the PC's ops.ts constant must equal this list).
select is((select string_agg(kind, ',' order by kind) from public._register_kind_perms where money),
  'payment.collect,purchase.payment.add,purchase.payment.delete,purchase.receive,sale.create,'
  'sale.recheckout,sale.refund,sale.void,shift.close,stock.adjust',
  'V4 the money column is exactly MONEY_KINDS');
select is((select string_agg(kind, ',' order by kind) from public._register_kind_perms where log),
  'auth.lockout,clock.reset,credential.set,noop,session.end,session.start',
  'V5 the log column is LOG_KINDS plus noop');
select is((select coalesce(string_agg(distinct k.writer || '/' || r, ','), '')
             from public._register_kind_perms k, unnest(array['public', 'anon', 'authenticated', 'service_role']) r
            where r <> 'public' and has_function_privilege(r, format('public.%I(uuid, uuid, timestamptz, jsonb, text)', k.writer), 'execute')),
  '', 'V6 no writer is executable by anon, authenticated or service_role');
select is((select coalesce(string_agg(f || '/' || r, ','), '')
             from unnest(array['public._license_state(uuid)', 'public._license_feature_for(uuid, text)',
                               'public._store_day_range(uuid, date)', 'public._ingest_ref(text, uuid, uuid)',
                               'public._ingest_can(uuid, uuid, text)', 'public._ingest_detail(jsonb)',
                               'public._register_guard(uuid, text, uuid, uuid, jsonb)',
                               'public._register_flags(uuid, text, uuid, uuid, timestamptz, jsonb, timestamptz)',
                               'public._register_envelope(uuid)']) f,
                  unnest(array['anon', 'authenticated', 'service_role']) r
            where has_function_privilege(r, f, 'execute')),
  '', 'V7 the internals are closed to every client role');
select ok(has_function_privilege('authenticated', 'public.register_ingest(integer, integer, integer, timestamptz, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.register_ping(integer, integer, timestamptz)', 'execute')
          and has_function_privilege('authenticated', 'public.register_resolve_held(uuid, bigint, text)', 'execute')
          and not has_function_privilege('anon', 'public.register_ingest(integer, integer, integer, timestamptz, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.register_ping(integer, integer, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.register_resolve_held(uuid, bigint, text)', 'execute'),
  'V8 register_ingest, register_ping and register_resolve_held: authenticated yes, anon no');
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like '\_ingest\_%' or p.proname like '\_register\_%' or p.proname like 'register\_%'
                   or p.proname in ('_license_state', '_license_feature_for', '_store_day_range'))
              and p.proname not in ('_register_bypass', '_register_bypass_ok', '_register_ingest_store',
                                    '_register_install', '_register_convert_staff', '_register_mark_local',
                                    '_register_username_keys', 'register_store_id', 'register_snapshot_open',
                                    'register_status', 'register_flags', 'register_photo_ticket',
                                    'register_photo_ticket_use', 'register_photo_tickets_open', 'register_photo_fetched',
                                    '_ingest_uuid', '_ingest_ts', '_ingest_id', '_ingest_detail')
              and not (p.prosecdef and 'search_path=public' = any(p.proconfig))),
  '', 'V9 every new definer function is SECURITY DEFINER with search_path=public');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public._register_kind_perms'::regclass)
          and not has_table_privilege('authenticated', 'public._register_kind_perms', 'select')
          and not has_table_privilege('anon', 'public._register_kind_perms', 'select'),
  'V10 _register_kind_perms: RLS forced, no client privilege');
select ok(exists (select 1 from public.lensy_schema_versions where version = 34),
  'V11 034 stamps itself (working number)');

-- ===== L: the licence refactor keeps every answer =========================
select _as(u('11'));
select is(_lic_cases(), '', 'L1 my_license_state() and license_feature() answer as 026/027 for every licence shape');
select _as(u('71'));
select ok((select count(*) from public.my_license_state()) = 0 and public.license_feature('lab'),
  'L2 ...and for a caller with no staff store: no licence row, every feature allowed (027)');
select _as(null);
update public.store_licenses set features = '{"lab": false}', max_staff = 4 where store_id = s_a();
select ok(not public._license_feature_for(s_a(), 'lab') and public._license_feature_for(s_b(), 'lab')
          and public._license_feature_for(s_a(), 'other'),
  'L3 _license_feature_for answers for the named store');
select is((select to_jsonb(l) - 'starts_at' from public._license_state(s_a()) l),
  '{"plan": "pro", "state": "active", "features": {"lab": false}, "max_staff": 4, "expires_at": null, "is_revoked": false, "store_name": "Store A34"}'::jsonb,
  'L4 _license_state carries max_staff, features and is_revoked for the piggyback');
update public.store_licenses set features = '{}', max_staff = null where store_id = s_a();

-- ===== Z: the store's day ==================================================
select is((select row(from_at, to_at)::text from public._store_day_range(s_a(), '2026-01-15')),
  row('2026-01-14 22:00:00+00'::timestamptz, '2026-01-15 22:00:00+00'::timestamptz)::text,
  'Z1 _store_day_range: A''s (Africa/Cairo) 15 January runs 22:00 to 22:00 UTC');

-- ===== C: the early answers ================================================
select _as(u('11'));
select is(public.register_ingest(1, 1, 0, null, '[]'::jsonb) - 'server_now',
  '{"current": false, "reason": "replaced"}'::jsonb,
  'C1 a staff login is not a register: current false, reason replaced');
select _as(null);

set role authenticated; select _as(u('61'));
select public.set_store_owner(s_a(), u('11'));
select public.set_store_owner(s_c(), u('31'));
reset role;
set role service_role; select _as(null);
select public._register_install(s_a(), u('71'), u('11'));
select public._register_install(s_c(), u('73'), u('31'));
reset role;

select _as(u('71'));
select is(public.register_ingest(2, 1, 0, null, '[]'::jsonb) - 'server_now',
  '{"current": false, "reason": "replaced", "epoch": 1}'::jsonb,
  'C2 another epoch: current false, reason replaced, with the current epoch');
select ok((public.register_ingest(1, 0, 0, null, jsonb_build_array(op(1, 'session.start', u('11'), '{}'))) ->> 'upgrade_required')::boolean
          and (rg()).last_seq = 0,
  'C3 a protocol below min_protocol: upgrade_required, nothing applied');
select ok((select (j ->> 'retry')::boolean and j ->> 'reason' = 'batch_too_large'
             from (select ing((select jsonb_agg(op(g, 'session.start', u('11'), '{}')) from generate_series(1, 201) g)) j) x)
          and (rg()).last_seq = 0,
  'C4 201 ops: retry with reason batch_too_large, nothing applied');
select ok((select (z.j -> 'store_day' ->> 'from')::timestamptz = (select from_at from public._store_day_range(s_a(), null))
                  and (z.j -> 'store_day' ->> 'from')::timestamptz
                      <> ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC'
             from (select public.register_ping(1, 0, null) j) z)
          and (select from_at from public.store_day_range()) = ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC',
  'Z2 the register''s store_day is the Cairo day (the public store_day_range would answer the UTC day)');

-- ===== S: the first batch, as the authenticated role =======================
set role authenticated; select _as(u('71'));
insert into _r select 's1', public.register_ingest(1, 1, 3, now() - interval '1 hour', jsonb_build_array(
  op(1, 'session.start', u('11'), jsonb_build_object('sid', u('5a'), 'user_id', u('11')), now() - interval '8 days'),
  op(2, 'session.start', u('13'), jsonb_build_object('sid', u('5c'), 'user_id', u('13')), now() - interval '8 days')));
select ok(current_setting('lensy.ingest', true) = '' and current_setting('lensy.store', true) = ''
          and current_setting('lensy.actor', true) = '' and current_setting('lensy.event_at', true) = ''
          and current_setting('lensy.seq', true) = '',
  'S1 every lensy.* GUC is empty after register_ingest returns');
reset role;
select is((select j - 'server_now' - 'license' - 'store_day' - 'catalog' - 'commands' from _r where k = 's1'),
  '{"current": true, "reason": null, "epoch": 1, "acked_seq": 2, "more": false, "retry": false, "min_protocol": 1,
    "held": null, "conflict": null, "results": [], "dup": 0, "flags_total": 0, "skipped_total": 0, "parked_total": 0}'::jsonb,
  'S2 two session.start ops: acked_seq 2, no results, nothing held');
select ok((select count(*) from public.register_ops where store_id = s_a() and status = 'ok') = 2
          and (select count(*) from public.register_bypass) = 0,
  'S3 both logged ok, and the ingest token is closed');
select ok((rg()).last_ingest_at = now() and (rg()).last_contact_at = now() and (rg()).pending_reported = 3
          and (rg()).oldest_pending_at = now() - interval '1 hour',
  'S4 last_ingest_at, last_contact_at, pending_reported and oldest_pending_at stamped');
select is((select j ->> 'catalog' from _r where k = 's1'), md5(array_to_string(public.supported_permissions(), ',')),
  'S5 catalog = md5 of supported_permissions()');

-- ===== T: event times verbatim, attribution ================================
create table _t (t timestamptz);
insert into _t values (now() - interval '7 days');
create function t7() returns timestamptz language sql stable as $$ select t from _t $$;
select _as(u('71'));
insert into _r select 't1', ing(jsonb_build_array(
  op(3,  'customer.upsert', u('11'), jsonb_build_object('id', u('e1'), 'name', 'Mona', 'phone', '0101'), t7()),
  op(4,  'product.upsert',  u('11'), jsonb_build_object('id', u('e2'), 'name', 'Frame T', 'sku', 'FT-1', 'sale_price', 100,
                                                       'cost_price', 40, 'initial', jsonb_build_object('movement_id', u('e3'), 'qty', 10)), t7()),
  op(5,  'stock.adjust',    u('11'), jsonb_build_object('movement_id', u('e4'), 'product_id', u('e2'), 'qty', -2,
                                                       'type', 'adjustment', 'note', 'broken'), t7()),
  op(6,  'note.upsert',     u('13'), jsonb_build_object('id', u('e5'), 'body', 'cashier note'), t7()),
  op(7,  'supplier.upsert', u('11'), jsonb_build_object('id', u('e6'), 'name', 'Lens Co'), t7()),
  op(8,  'metadata.upsert', u('11'), jsonb_build_object('table', 'lens_types', 'id', u('e7'), 'name', 'Single vision', 'sort_order', 1), t7()),
  op(9,  'metadata.upsert', u('11'), jsonb_build_object('table', 'frame_types', 'id', u('e9'), 'name', 'Full rim'), t7()),
  op(10, 'setting.set',     u('11'), jsonb_build_object('id', u('ea'), 'key', 'receipt_footer', 'value', 'Thank you'), t7())));
select is((select j -> 'results' from _r where k = 't1'), '[]'::jsonb, 'T1 eight entity ops at t = now() - 7 days: all ok');
select ok((select created_at from public.customers where id = u('e1')) = t7()
          and (select created_at from public.inventory where id = u('e2')) = t7()
          and (select bool_and(created_at = t7()) and count(*) = 2 from public.stock_movements where id in (u('e3'), u('e4')))
          and (select created_at from public.notes where id = u('e5')) = t7()
          and (select created_at from public.suppliers where id = u('e6')) = t7()
          and (select created_at from public.lens_types where id = u('e7')) = t7()
          and (select created_at from public.frame_types where id = u('e9')) = t7()
          and (select created_at from public.settings where id = u('ea')) = t7(),
  'T2 every row the ops wrote carries the op''s t, verbatim');
select ok((select bool_and(occurred_at = t7()) and count(*) = 8 from public.register_ops where store_id = s_a() and seq between 3 and 10),
  'T3 register_ops.occurred_at = t for each op');
select is((select stock_qty from public.inventory where id = u('e2')), 8, 'T4 stock_qty follows the movements (10 - 2)');
select ok((select bool_and(via_register and event_at = t7() and actor = u('11') and store_id = s_a()) and count(*) = 2
             from public.audit_log where table_name = 'stock_movements' and row_id in (u('e3')::text, u('e4')::text)),
  'T5 audit_log: via_register, event_at = t, actor = the op''s actor, store A');
select ok((select created_by from public.notes where id = u('e5')) = u('13'),
  'T6 attribution: notes.created_by is the op''s actor (the cashier), not the register login');
select ok((select bool_and(store_id = s_a()) from (
            select store_id from public.customers where id = u('e1') union all
            select store_id from public.inventory where id = u('e2') union all
            select store_id from public.stock_movements where id in (u('e3'), u('e4')) union all
            select store_id from public.notes where id = u('e5') union all
            select store_id from public.suppliers where id = u('e6') union all
            select store_id from public.lens_types where id = u('e7') union all
            select store_id from public.frame_types where id = u('e9') union all
            select store_id from public.settings where id = u('ea')) x),
  'T7 store_id = the register''s store on every row (never from the payload)');

-- ===== K: an ok test for every kind of this step ===========================
select one('k_cust_up', 'customer.upsert', u('11'), jsonb_build_object('id', u('e1'), 'name', 'Mona S', 'phone', '0102'));
select ok(st('k_cust_up') = 'ok' and (select name = 'Mona S' and created_at = t7() from public.customers where id = u('e1')),
  'K1 customer.upsert of an existing customer: updated, created_at kept');
select one('k_cust_new', 'customer.upsert', u('11'), jsonb_build_object('id', u('f1'), 'name', 'To delete'));
select one('k_cust_del', 'customer.delete', u('11'), jsonb_build_object('id', u('f1')));
select ok(st('k_cust_new') = 'ok' and st('k_cust_del') = 'ok' and not exists (select 1 from public.customers where id = u('f1')),
  'K2 customer.delete: gone');
select one('k_prod_up', 'product.upsert', u('11'), jsonb_build_object('id', u('e2'), 'name', 'Frame T', 'sku', 'FT-1',
                                                                      'sale_price', 120, 'cost_price', 40));
select ok(st('k_prod_up') = 'ok' and (select sale_price = 120 and stock_qty = 8 from public.inventory where id = u('e2')),
  'K3 product.upsert of an existing product: updated, stock untouched');
select one('k_stock', 'stock.adjust', u('11'), jsonb_build_object('movement_id', u('f2'), 'product_id', u('e2'), 'qty', 5));
select ok(st('k_stock') = 'ok' and (select stock_qty from public.inventory where id = u('e2')) = 13
          and (select kind = 'adjustment' from public.stock_movements where id = u('f2')),
  'K4 stock.adjust: a movement (kind adjustment), stock 13');
select one('k_md_up', 'metadata.upsert', u('11'), jsonb_build_object('table', 'frame_colors', 'id', u('f3'), 'name', 'Black'));
select one('k_md_up2', 'metadata.upsert', u('11'), jsonb_build_object('table', 'lens_types', 'id', u('f4'), 'name', 'Progressive', 'sort_order', 2));
select one('k_md_re', 'metadata.reorder', u('11'), jsonb_build_object('table', 'lens_types', 'ids', jsonb_build_array(u('f4'), u('e7'))));
select one('k_md_del', 'metadata.delete', u('11'), jsonb_build_object('table', 'frame_types', 'id', u('e9')));
select ok(st('k_md_up') = 'ok' and st('k_md_up2') = 'ok' and st('k_md_re') = 'ok' and st('k_md_del') = 'ok'
          and exists (select 1 from public.frame_colors where id = u('f3') and name = 'Black')
          and (select sort_order from public.lens_types where id = u('f4')) = 1
          and (select sort_order from public.lens_types where id = u('e7')) = 2
          and not exists (select 1 from public.frame_types where id = u('e9')),
  'K5 metadata.upsert, .reorder (1-based positions) and .delete');
select one('k_sup_up', 'supplier.upsert', u('11'), jsonb_build_object('id', u('e6'), 'name', 'Lens Co Ltd', 'phone', '02'));
select one('k_sup_new', 'supplier.upsert', u('11'), jsonb_build_object('id', u('f5'), 'name', 'Gone Co'));
select one('k_sup_del', 'supplier.delete', u('11'), jsonb_build_object('id', u('f5')));
select ok(st('k_sup_up') = 'ok' and st('k_sup_new') = 'ok' and st('k_sup_del') = 'ok'
          and (select name from public.suppliers where id = u('e6')) = 'Lens Co Ltd'
          and not exists (select 1 from public.suppliers where id = u('f5')),
  'K6 supplier.upsert and supplier.delete');
select one('k_note_new', 'note.upsert', u('11'), jsonb_build_object('id', u('f6'), 'body', 'owner note'));
select one('k_note_ed', 'note.upsert', u('11'), jsonb_build_object('id', u('f6'), 'body', 'owner note, edited'));
select one('k_note_del', 'note.delete', u('11'), jsonb_build_object('id', u('e5')));
select ok(st('k_note_new') = 'ok' and st('k_note_ed') = 'ok' and st('k_note_del') = 'ok'
          and (select body = 'owner note, edited' and updated_at = now() and created_by = u('11') from public.notes where id = u('f6'))
          and not exists (select 1 from public.notes where id = u('e5')),
  'K7 note.upsert (new, edit: updated_at = t) and note.delete (an admin deletes the cashier''s note)');
select one('k_set', 'setting.set', u('11'), jsonb_build_object('id', u('fe'), 'key', 'receipt_footer', 'value', 'Shukran'));
select ok(st('k_set') = 'ok' and (select value = 'Shukran' and id = u('ea') from public.settings where store_id = s_a() and key = 'receipt_footer'),
  'K8 setting.set on an existing key: the value changes, the row keeps its id');
select one('k_store', 'store.update', u('11'), '{"allow_negative_stock": false, "time_zone": "Africa/Cairo"}');
select ok(st('k_store') = 'ok' and (select not allow_negative_stock and time_zone = 'Africa/Cairo' from public.stores where id = s_a()),
  'K9 store.update: allow_negative_stock and time_zone');
select one('k_sess', 'session.start', u('11'), jsonb_build_object('sid', u('5b'), 'user_id', u('11')), now(), u('5b'));
select one('k_send', 'session.end', u('11'), jsonb_build_object('sid', u('5b'), 'reason', 'signout'), now(), u('5b'));
select one('k_cred', 'credential.set', u('11'), jsonb_build_object('user_id', u('13'), 'by', u('11'), 'kind', 'pin'));
select one('k_lock', 'auth.lockout', u('13'), jsonb_build_object('user_id', u('13'), 'failures', 5), now(), null, '{"sid": null}');
select ok(st('k_sess') = 'ok' and st('k_send') = 'ok' and st('k_cred') = 'ok' and st('k_lock') = 'ok',
  'K10 session.start, session.end, credential.set and auth.lockout (no sid) log ok');
select one('k_clock', 'clock.reset', u('11'), jsonb_build_object('from', now() - interval '1 hour', 'to', now()));
select ok(st('k_clock') = 'flagged' and vi('k_clock') = '{clock_reset}',
  'K11 clock.reset is logged with its own flag clock_reset');
select one('k_noop', 'noop', u('11'), jsonb_build_object('skipped', op(0, 'note.upsert', u('13'), jsonb_build_object('id', u('f7'), 'body', 'x')),
                                                       'reason', 'held', 'by', u('11')));
select ok(st('k_noop') = 'skipped' and vi('k_noop') = '{skipped:note.upsert}' and (rg()).skipped_total = 1
          and not exists (select 1 from public.notes where id = u('f7'))
          and (select (j ->> 'skipped_total')::int from _r where k = 'k_noop') = 1,
  'K12 noop: skipped with skipped:<kind>, skipped_total 1, the skipped op not applied');
select is((select count(*)::int from public.register_ops where store_id = s_a() and status = 'ok' and occurred_at = now()
             and kind in ('customer.upsert', 'customer.delete', 'product.upsert', 'stock.adjust', 'metadata.upsert',
                          'metadata.delete', 'metadata.reorder', 'supplier.upsert', 'supplier.delete', 'note.upsert',
                          'note.delete', 'setting.set', 'store.update', 'session.start', 'session.end',
                          'credential.set', 'auth.lockout')), 21,
  'K13 every non-flag kind of this step has at least one ok op');

-- ===== F: each flag fires once, alone ======================================
select one('f_inactive', 'session.start', u('16'), jsonb_build_object('sid', u('5e'), 'user_id', u('16')), now(), u('5e'));
select is(vi('f_inactive'), '{actor_inactive}', 'F1 actor_inactive');
select one('f_perm_dyn', 'customer.upsert', u('13'), jsonb_build_object('id', u('e1'), 'name', 'Mona C'));
select ok(vi('f_perm_dyn') = '{perm:customers.edit}' and (select name from public.customers where id = u('e1')) = 'Mona C',
  'F2 perm: a cashier editing a customer: perm:customers.edit, and the edit is applied');
select one('f_cust3', 'customer.upsert', u('13'), jsonb_build_object('id', u('f8'), 'name', 'New by cashier'));
select one('f_perm_st', 'customer.delete', u('13'), jsonb_build_object('id', u('f8')));
select ok(st('f_cust3') = 'ok' and vi('f_perm_st') = '{perm:customers.delete}' and not exists (select 1 from public.customers where id = u('f8')),
  'F3 perm (static, from the kind table): perm:customers.delete; a cashier''s create is ok');
select one('f_nosess', 'note.upsert', u('13'), jsonb_build_object('id', u('f9'), 'body', 'x'), now(), u('5f'));
select is(vi('f_nosess'), '{no_session}', 'F4 no_session: a sid that was never started');
select one('f_ended', 'note.upsert', u('11'), jsonb_build_object('id', u('fa'), 'body', 'x'), now(), u('5b'));
select is(vi('f_ended'), '{no_session}', 'F5 no_session: a sid that was ended');
update public.store_licenses set is_revoked = true where store_id = s_a();
select one('f_lic_rev', 'note.upsert', u('11'), jsonb_build_object('id', u('fb'), 'body', 'x'));
update public.store_licenses set is_revoked = false, expires_at = now() - interval '1 hour' where store_id = s_a();
select one('f_lic_exp', 'note.upsert', u('11'), jsonb_build_object('id', u('fc'), 'body', 'x'));
select one('f_lic_log', 'credential.set', u('11'), jsonb_build_object('user_id', u('11'), 'by', u('11'), 'kind', 'pin'));
update public.store_licenses set expires_at = null where store_id = s_a();
select ok(vi('f_lic_rev') = '{licence}' and vi('f_lic_exp') = '{licence}' and st('f_lic_log') = 'ok'
          and exists (select 1 from public.notes where id = u('fb')) and exists (select 1 from public.notes where id = u('fc')),
  'F6 licence: revoked, or t past expires_at -> applied and flagged; a log kind is not flagged');
update public.store_licenses set features = '{"lab": false}' where store_id = s_a();
select ok(public._register_flags(s_a(), 'sale.lab_status', u('11'), u('5a'), now(), '{}') = '{feature:lab}'
          and public._register_flags(s_a(), 'note.upsert', u('11'), u('5a'), now(), '{"id": "x"}') = '{}',
  'F7 feature:lab: the flag evaluator flags sale.lab_status, and only it (its writer is step 2''s; see the note)');
-- (the ingest-level sale.lab_status op with feature:lab is M34 below)
select _as(u('11'));
select ok(public.license_feature('lab') = _lf027('lab') and not public.license_feature('lab'),
  'F8 ...while license_feature(''lab'') answers a staff session exactly as 027 did');
select _as(u('71'));
update public.store_licenses set features = '{}' where store_id = s_a();
select one('f_back', 'note.upsert', u('11'), jsonb_build_object('id', u('fd'), 'body', 'x'), now() - interval '1 hour');
select is(vi('f_back'), '{clock_back}', 'F9 clock_back: t more than 5 minutes before max_t');
select _token(s_a(), true);
insert into public.shift_closes (id, store_id, from_at, to_at, counted_cash, expected_cash, expected_total, variance)
values (u('c9'), s_a(), now() - interval '2 days', now() + interval '1 hour', 0, 0, 0, 0);
select _token(s_a(), false);
select one('f_shift', 'stock.adjust', u('11'), jsonb_build_object('movement_id', u('c8'), 'product_id', u('e2'), 'qty', 1));
select one('f_shift_no', 'note.upsert', u('11'), jsonb_build_object('id', u('c7'), 'body', 'x'));
select ok(vi('f_shift') = '{in_closed_shift}' and st('f_shift_no') = 'ok',
  'F10 in_closed_shift: a MONEY_KINDS op before the latest close; other kinds are not');
select _token(s_a(), true);
delete from public.shift_closes where id = u('c9');
select _token(s_a(), false);
select one('f_tz', 'note.upsert', u('11'), jsonb_build_object('id', u('c6'), 'body', 'x'), now(), null, '{"f": ["tz_mismatch", "other"]}');
select is(vi('f_tz'), '{tz_mismatch}', 'F11 tz_mismatch: carried by the op''s f key (only that code is honoured)');
select one('f_neg', 'stock.adjust', u('11'), jsonb_build_object('movement_id', u('c5'), 'product_id', u('e2'), 'qty', -100));
select ok(vi('f_neg') = '{negative_stock}' and (select stock_qty from public.inventory where id = u('e2')) = -86,
  'F12 negative_stock: the store forbids it and the adjustment went below zero (applied: the units left)');
select one('f_auth', 'note.upsert', u('13'), jsonb_build_object('id', u('c4'), 'body', 'for the owner only', 'user_id', u('11')));
select ok(vi('f_auth') = '{note_authorship}' and (select created_by = u('13') and user_id = u('11') from public.notes where id = u('c4')),
  'F13 note_authorship: a private note for someone else');
select one('f_delmiss', 'customer.delete', u('11'), jsonb_build_object('id', u('c3')));
select is(vi('f_delmiss'), '{delete_missing}', 'F14 delete_missing');
select one('f_tgtmiss', 'metadata.reorder', u('11'), jsonb_build_object('table', 'lens_types', 'ids', jsonb_build_array(u('e7'), u('c2'))));
select ok(vi('f_tgtmiss') = '{target_missing}' and (select sort_order from public.lens_types where id = u('e7')) = 1,
  'F15 target_missing: a reorder naming a missing row (the others still move)');
select one('f_unk', 'customer.upsert', u('11'), jsonb_build_object('id', u('e1'), 'name', 'Mona', 'shoe_size', 39));
select ok(vi('f_unk') = '{unknown_fields}'
          and (select detail -> 'unknown_fields' from public.register_ops where store_id = s_a() and seq = sq('f_unk')) = '["shoe_size"]'
          and (select payload ? 'shoe_size' from public.register_ops where store_id = s_a() and seq = sq('f_unk')),
  'F16 unknown_fields, listed in detail; the payload is stored whole');
select one('f_ahead', 'note.upsert', u('11'), jsonb_build_object('id', u('c1'), 'body', 'x'), now() + interval '1 hour');
select ok(vi('f_ahead') = '{clock_ahead}' and (rg()).max_t = now() + interval '10 minutes',
  'F17 clock_ahead; max_t is not advanced past now() + 10 minutes');
update public.store_registers set max_t = now() where store_id = s_a();
select one('f_neg_ok', 'store.update', u('11'), '{"allow_negative_stock": true}');

-- ===== H: holds ============================================================
select ok(st('f_neg_ok') = 'ok', 'H0 (store.update back to allow_negative_stock true)');

-- ===== M: the money and purchase writers (step 2) ==========================
-- Ids of this block: w('xx'). The clerk (14, role Clerk34: pos.edit,
-- history.view/edit/void, closing.*, suppliers.view/edit, no history.refund,
-- lab.edit or suppliers.create, not an admin) isolates the target-dependent
-- perm: codes; its session is w('f0').
create function w(p text) returns uuid language sql immutable as $$
  select ('34000000-0000-4000-8000-0000000002' || p)::uuid $$;
create function cl(p_key text, p_k text, p_p jsonb, p_t timestamptz default now()) returns jsonb
language sql as $$ select one(p_key, p_k, u('14'), p_p, p_t, w('f0')) $$;
create function hc(p_key text) returns text language sql stable as $$
  select (rg()).held_code where (rg()).held_seq = sq(p_key) $$;
create function hm(p_key text) returns text language sql stable as $$
  select (rg()).held_error ->> 'message' where (rg()).held_seq = sq(p_key) $$;
create function det(p_key text) returns jsonb language sql stable as $$
  select o.detail from public.register_ops o where o.store_id = s_a() and o.seq = sq(p_key) $$;
-- a sale line and a ledger row as the PC sends them
create function li(p_id uuid, p_prod uuid, p_qty integer, p_price numeric, p_disc numeric default 0, p_mv uuid default null)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'product_id', p_prod, 'name', 'line', 'qty', p_qty,
           'unit_price', p_price, 'total_price', p_qty * p_price, 'discount', p_disc, 'movement_id', p_mv)) $$;
create function pa(p_id uuid, p_method text, p_amount numeric) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'method', p_method, 'amount', p_amount) $$;
-- the header price_cart stores for these lines and this net (030:174-190)
create function hd(p_items jsonb, p_net numeric) returns jsonb language sql immutable as $$
  select case when p_net <= x.g + 0.01
              then jsonb_build_object('total_amount', x.g, 'discount', greatest(0, x.g - p_net),
                                      'net_amount', x.g - greatest(0, x.g - p_net))
              else jsonb_build_object('total_amount', p_net, 'discount', 0, 'net_amount', p_net) end
    from (select coalesce(sum((e ->> 'qty')::numeric * (e ->> 'unit_price')::numeric), 0) as g
            from jsonb_array_elements(p_items) e) x $$;
create function sc(p_id uuid, p_inv text, p_items jsonb, p_pays jsonb, p_net numeric, p_extra jsonb default '{}')
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'invoice_no', p_inv, 'kind', 'sale', 'payment_method', 'Cash',
           'lab_status', null, 'items', p_items, 'exams', '[]'::jsonb, 'payments', p_pays)
         || hd(p_items, p_net) || p_extra $$;
create function rc(p_sale uuid, p_items jsonb, p_net numeric, p_moves jsonb, p_pays jsonb, p_extra jsonb default '{}')
returns jsonb language sql immutable as $$
  select jsonb_build_object('sale_id', p_sale, 'payment_method', 'Cash', 'lab_status', null, 'items', p_items,
           'exams', '[]'::jsonb, 'movements', p_moves, 'payments', p_pays)
         || hd(p_items, p_net) || p_extra $$;
create function qty(p uuid) returns integer language sql stable as $$
  select stock_qty from public.inventory where id = p $$;
create function led(p_sale uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(x.method, x.a), '{}'::jsonb)
    from (select method, sum(amount) as a from public.sale_payments where sale_id = p_sale group by 1) x $$;
create function sal(p uuid) returns public.sales language sql stable as $$
  select * from public.sales where id = p $$;

select _token(s_a(), true);
insert into public.roles (id, name, store_id) values (w('a3'), 'Clerk34', s_a());
insert into public.role_permissions (role_id, permission_id)
select w('a3'), p.id from public.permissions p
 where p.code in ('pos.view', 'pos.create', 'pos.edit', 'history.view', 'history.edit', 'history.void',
                  'closing.view', 'closing.edit', 'suppliers.view', 'suppliers.edit', 'inventory.view');
insert into public.users (id, username, password_hash, store_id, role_id, is_active)
values (u('14'), 'clerk_a34', 'register-local', s_a(), w('a3'), true);
select _token(s_a(), false);
select _as(u('71'));
select one('m_sess', 'session.start', u('14'), jsonb_build_object('sid', w('f0'), 'user_id', u('14')), now(), w('f0'));
-- products P1..P4: w('01'), w('03'), w('05'), w('07')
select one('m_p1', 'product.upsert', u('11'), jsonb_build_object('id', w('01'), 'name', 'Frame M1', 'sku', 'FM-1',
  'sale_price', 500, 'cost_price', 200, 'initial', jsonb_build_object('movement_id', w('02'), 'qty', 10)));
select one('m_p2', 'product.upsert', u('11'), jsonb_build_object('id', w('03'), 'name', 'Lens M2', 'sku', 'LM-2',
  'sale_price', 300, 'cost_price', 100, 'initial', jsonb_build_object('movement_id', w('04'), 'qty', 10)));
select one('m_p3', 'product.upsert', u('11'), jsonb_build_object('id', w('05'), 'name', 'Case M3', 'sku', 'CM-3',
  'sale_price', 20, 'cost_price', 5, 'initial', jsonb_build_object('movement_id', w('06'), 'qty', 1)));
select one('m_p4', 'product.upsert', u('11'), jsonb_build_object('id', w('07'), 'name', 'Cloth M4', 'sku', 'CL-4',
  'sale_price', 10, 'cost_price', 2, 'initial', jsonb_build_object('movement_id', w('08'), 'qty', 1)));
select ok(st('m_sess') = 'ok' and st('m_p1') = 'ok' and st('m_p2') = 'ok' and st('m_p3') = 'ok' and st('m_p4') = 'ok'
          and qty(w('01')) = 10 and qty(w('05')) = 1,
  'M0 (fixtures: the clerk''s session, four products with opening stock)');

-- ---- ok: one sale through every money kind ----
-- S1 w('10'): 2 x P1 at 500 with a 100 line discount + 1 x P2 at 300, net
-- 1150 (total 1300, discount 150), paid 600 cash + 400 card.
select one('m_create', 'sale.create', u('11'), sc(w('10'), '340001',
  jsonb_build_array(li(w('11'), w('01'), 2, 500, 100, w('12')), li(w('13'), w('03'), 1, 300, 0, w('14'))),
  jsonb_build_array(pa(w('15'), 'cash', 600), pa(w('16'), 'card', 400)), 1150,
  jsonb_build_object('idempotency_key', w('18'), 'customer_id', u('e1'), 'doctor_name', 'Dr M', 'lab_status', 'Not Started',
                     'exams', jsonb_build_array(jsonb_build_object('id', w('17'), 'exam_type', 'distance', 'sphere_od', '-1.00')))));
select ok(st('m_create') = 'ok'
          and (select total_amount = 1300 and discount = 150 and net_amount = 1150 and amount_paid = 1000
                      and invoice_no = '340001' and kind = 'sale' and customer_id = u('e1') and idempotency_key = w('18')
                      and lab_status = 'Not Started' and lab_status_changed_at is null and store_id = s_a()
                 from public.sales where id = w('10')),
  'M1 sale.create ok: the header as sent (net 1150 after the line discount), amount_paid from the ledger');
select ok((select order_date = now() and created_at = now() and user_id = u('11') from public.sales where id = w('10'))
          and (select count(*) = 2 and bool_and(created_at = now() and store_id = s_a()) from public.sale_items where sale_id = w('10'))
          and (select discount from public.sale_items where id = w('11')) = 100
          and (select doctor_name = 'Dr M' and created_at = now() from public.order_examinations where id = w('17'))
          and (select bool_and(type = 'sale' and kind = 'sale' and ref_no = '340001' and created_at = now()) and sum(qty) = -3
                 from public.stock_movements where id in (w('12'), w('14')))
          and qty(w('01')) = 8 and qty(w('03')) = 9,
  'M2 ...its lines, exam (the header''s doctor) and one sale movement per line, all at t; stock 8 and 9');
select ok((select count(*) = 2 and bool_and(recorded_by = u('11') and paid_at = now() and kind = 'payment' and store_id = s_a())
             from public.sale_payments where sale_id = w('10'))
          and (select next_val from public.invoice_counter where store_id = s_a() and prefix = '') = 340002,
  'M3 ...ledger rows recorded_by the op''s actor at t; invoice_counter raised past 340001 (design 2.6)');
-- re-checkout: one more P2 (total 1600, net 1450), +300 card appended
select one('m_rc', 'sale.recheckout', u('11'), rc(w('10'),
  jsonb_build_array(li(w('11'), w('01'), 2, 500, 100), li(w('13'), w('03'), 2, 300)), 1450,
  jsonb_build_array(jsonb_build_object('id', w('19'), 'product_id', w('03'), 'qty', -1)),
  jsonb_build_array(pa(w('1a'), 'card', 300)),
  jsonb_build_object('customer_id', u('e1'), 'lab_status', 'Not Started',
                     'exams', jsonb_build_array(jsonb_build_object('id', w('17'), 'exam_type', 'distance')),
                     'expect', jsonb_build_object('paid', 1000, 'tenders', jsonb_build_array(
                        jsonb_build_object('method', 'cash', 'amount', 600), jsonb_build_object('method', 'card', 'amount', 400))))));
select ok(st('m_rc') = 'ok' and (rg()).held_seq is null
          and (select total_amount = 1600 and discount = 150 and net_amount = 1450 and amount_paid = 1300 and doctor_name = 'Dr M'
                 from public.sales where id = w('10'))
          and current_setting('lensy.money_write', true) = '',
  'M4 a re-checkout whose total changes applies (no 42501) and leaves lensy.money_write empty');
select ok((select count(*) from public.sale_payments where sale_id = w('10')) = 3
          and (select amount = 600 and paid_at = now() from public.sale_payments where id = w('15'))
          and led(w('10')) = '{"cash": 600, "card": 700}'::jsonb
          and (select qty = -1 and note = 'POS Re-checkout: 340001' from public.stock_movements where id = w('19'))
          and qty(w('03')) = 8 and (select qty from public.sale_items where id = w('13')) = 2,
  'M5 ...append-only: the ledger keeps its rows and gains the +300 card delta; stock moves by the delta only');
select one('m_col', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('10'),
  'lines', jsonb_build_array(pa(w('1b'), 'instapay', 150)),
  'expect', jsonb_build_object('paid', 1300, 'tenders', jsonb_build_object('cash', 600, 'card', 700))));
select ok(st('m_col') = 'ok' and (sal(w('10'))).amount_paid = 1450
          and (select kind = 'payment' and recorded_by = u('11') and paid_at = now() from public.sale_payments where id = w('1b')),
  'M6 payment.collect ok (expect as a {method: amount} map)');
select one('m_ref', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('10'), 'row', pa(w('1c'), 'cash', 100),
  'note', 'scratch', 'expect', jsonb_build_object('paid', 1450)));
select ok(st('m_ref') = 'ok' and (sal(w('10'))).amount_paid = 1350
          and (select amount = -100 and kind = 'refund' and note = 'Refund 340001: scratch' and recorded_by = u('11')
                 from public.sale_payments where id = w('1c')),
  'M7 sale.refund ok: -100 on cash, 028''s note');
select one('m_hdr', 'sale.header', u('11'), jsonb_build_object('sale_id', w('10'), 'doctor_name', 'Dr N',
  'delivery_date', '2026-12-01T10:00:00Z', 'rx_image_path', 'store/a/orders/rx-s1.jpg'));
select ok(st('m_hdr') = 'ok'
          and (select doctor_name = 'Dr N' and delivery_date = '2026-12-01T10:00:00Z' and rx_image_path = 'store/a/orders/rx-s1.jpg'
                      and lab_status = 'Not Started' and total_amount = 1600 from public.sales where id = w('10')),
  'M8 sale.header ok: only the keys sent change');
select one('m_exm', 'sale.exams', u('11'), jsonb_build_object('sale_id', w('10'),
  'exams', jsonb_build_array(jsonb_build_object('id', w('1d'), 'exam_type', 'near'))));
select ok(st('m_exm') = 'ok' and (select array_agg(id) from public.order_examinations where sale_id = w('10')) = array[w('1d')]
          and (select doctor_name is null from public.order_examinations where id = w('1d')),
  'M9 sale.exams ok: replaced (the doctor as sent, 029)');
select one('m_lab', 'sale.lab_status', u('11'), jsonb_build_object('sale_id', w('10'), 'status', 'In Lab'),
           now() + interval '1 minute');
select ok(st('m_lab') = 'ok'
          and (select lab_status = 'In Lab' and lab_status_changed_at = now() + interval '1 minute'
                      and lab_started_at = now() + interval '1 minute' from public.sales where id = w('10')),
  'M10 sale.lab_status ok: lab_status_changed_at = t (and lab_started_at)');
-- void after the partial refund: one refund per exact method still held
select one('m_void', 'sale.void', u('11'), jsonb_build_object('sale_id', w('10'), 'reason', ' customer left ',
  'refunds', jsonb_build_array(pa(w('1e'), 'cash', -500), pa(w('1f'), 'card', -700), pa(w('20'), 'instapay', -150)),
  'restock', jsonb_build_array(jsonb_build_object('id', w('21'), 'product_id', w('01'), 'qty', 2),
                               jsonb_build_object('id', w('22'), 'product_id', w('03'), 'qty', 2)),
  'expect', jsonb_build_object('paid', 1350)));
select ok(st('m_void') = 'ok'
          and (select voided_at = now() and voided_by = u('11') and void_reason = 'customer left' and amount_paid = 0
                 from public.sales where id = w('10'))
          and led(w('10')) = '{"cash": 0, "card": 0, "instapay": 0}'::jsonb
          and (select bool_and(type = 'return' and kind = 'void_restock' and note = 'Void 340001: customer left' and created_at = now())
                 from public.stock_movements where id in (w('21'), w('22')))
          and qty(w('01')) = 10 and qty(w('03')) = 10,
  'M11 sale.void after a partial refund: the ledger ends at 0 per method, the units are back, voided at t by the actor');

-- ---- flags of sale.create, each alone ----
select one('c_price', 'sale.create', u('11'), sc(w('23'), '340003', jsonb_build_array(li(w('24'), w('01'), 1, 450, 0, w('25'))), '[]', 450));
select ok(vi('c_price') = '{price_changed}' and (select unit_price from public.sale_items where id = w('24')) = 450
          and (det('c_price') -> 'price_changed' -> 0 ->> 'catalogue')::numeric = 500,
  'M12 price_changed: a line below the catalogue price (stored as sent; both prices in detail)');
select one('c_tender', 'sale.create', u('11'), sc(w('26'), '340004', jsonb_build_array(li(w('27'), w('01'), 1, 500, 0, w('28'))),
  jsonb_build_array(pa(w('29'), 'visa', 500)), 500));
select ok(vi('c_tender') = '{unknown_tender}' and (select method from public.sale_payments where id = w('29')) = 'visa',
  'M13 unknown_tender: new money on a tender the shop does not take (stored verbatim)');
select one('c_over', 'sale.create', u('11'), sc(w('2a'), '340005', jsonb_build_array(li(w('2b'), w('01'), 1, 500, 0, w('2c'))),
  jsonb_build_array(pa(w('2d'), 'cash', 600)), 500));
select ok(vi('c_over') = '{overpaid}' and (sal(w('2a'))).amount_paid = 600, 'M14 overpaid: paid above net');
select one('c_hdr', 'sale.create', u('11'), sc(w('2e'), '340006', jsonb_build_array(li(w('2f'), w('01'), 1, 500, 0, w('30'))), '[]', 450,
  '{"total_amount": 450, "discount": 0, "net_amount": 450}'));
select ok(vi('c_hdr') = '{header_rule}' and (det('c_hdr') -> 'header_rule' -> 'rule' ->> 'discount')::numeric = 50,
  'M15 header_rule: a discount folded into the total instead of the header discount');
select one('c_kind', 'sale.create', u('11'), sc(w('31'), '340007', jsonb_build_array(li(w('32'), w('01'), 1, 500, 0, w('33'))), '[]', 500,
  '{"kind": "prescription"}'));
select ok(vi('c_kind') = '{kind_rule}' and (sal(w('31'))).kind = 'prescription',
  'M16 kind_rule: ''prescription'' on a cart with a total (022)');
select one('c_renum', 'sale.create', u('11'), sc(w('34'), '340009', jsonb_build_array(li(w('35'), w('01'), 1, 500, 0, w('36'))), '[]', 500,
  '{"renumbered_from": "340008"}'));
select ok(vi('c_renum') = '{invoice_renumbered}' and det('c_renum') ->> 'renumbered_from' = '340008'
          and (select next_val from public.invoice_counter where store_id = s_a() and prefix = '') = 340010,
  'M17 invoice_renumbered (design 2.6/6.2), and the counter follows the highest number');
select one('m_noneg', 'store.update', u('11'), '{"allow_negative_stock": false}');
select one('c_neg', 'sale.create', u('11'), sc(w('37'), '340010', jsonb_build_array(li(w('38'), w('07'), 3, 10, 0, w('39'))), '[]', 30));
select ok(st('m_noneg') = 'ok' and vi('c_neg') = '{negative_stock}' and qty(w('07')) = -2,
  'M18 negative_stock: the store forbids it and the sale took the shelf below zero (applied)');
select one('m_neg_ok', 'store.update', u('11'), '{"allow_negative_stock": true}');

-- ---- flags of sale.recheckout, each alone, on SB w('40') ----
select one('m_sb', 'sale.create', u('11'), sc(w('40'), '340020', jsonb_build_array(li(w('41'), w('01'), 1, 500, 0, w('42'))),
  jsonb_build_array(pa(w('43'), 'cash', 300)), 500));
create function ib() returns jsonb language sql immutable as $$ select jsonb_build_array(li(w('41'), w('01'), 1, 500)) $$;
create function ib2() returns jsonb language sql immutable as $$
  select jsonb_build_array(li(w('41'), w('01'), 1, 500), li(w('4a'), w('05'), 5, 20)) $$;
select one('r_rx', 'sale.recheckout', u('11'), rc(w('40'), ib(), 500, '[]', '[]', '{"rx_image_path": "store/a/orders/rx1.jpg"}'));
select cl('r_photo', 'sale.recheckout', rc(w('40'), ib(), 500, '[]', '[]', '{"rx_image_path": "store/a/orders/rx2.jpg"}'));
select ok(st('m_sb') = 'ok' and st('r_rx') = 'ok' and vi('r_photo') = '{photo_replace_not_admin}'
          and (sal(w('40'))).rx_image_path = 'store/a/orders/rx2.jpg',
  'M19 photo_replace_not_admin: the clerk re-checks out with another photo (applied)');
select one('r_rx0', 'sale.recheckout', u('11'), rc(w('40'), ib(), 500, '[]', '[]'));
select one('r_first', 'sale.recheckout', u('11'), rc(w('40'), ib(), 500, '[]', jsonb_build_array(pa(w('44'), 'cash', -100))));
select ok(st('r_rx0') = 'ok' and vi('r_first') = '{refund_first}' and led(w('40')) = '{"cash": 200}'::jsonb
          and (select kind = 'refund' and note = 'Re-checkout refund 340020' from public.sale_payments where id = w('44')),
  'M20 refund_first: a re-checkout that gives money back (030:576-587), appended as a refund row');
select cl('r_refperm', 'sale.recheckout', rc(w('40'), ib(), 500, '[]',
  jsonb_build_array(pa(w('45'), 'card', 50), pa(w('46'), 'cash', -50))));
select ok(vi('r_refperm') = '{perm:history.refund}' and led(w('40')) = '{"cash": 150, "card": 50}'::jsonb,
  'M21 perm:history.refund: a tender goes down (cash -> card) for a clerk without history.refund');
select cl('r_lab', 'sale.recheckout', rc(w('40'), ib(), 500, '[]', '[]',
  jsonb_build_object('lab_status', 'Not Started', 'exams', jsonb_build_array(jsonb_build_object('id', w('47'), 'exam_type', 'distance')))));
select ok(vi('r_lab') = '{perm:lab.edit}' and (sal(w('40'))).lab_status = 'Not Started',
  'M22 perm:lab.edit: the clerk''s re-checkout changes the lab status');
select one('r_tender', 'sale.recheckout', u('11'), rc(w('40'), ib(), 500, '[]', jsonb_build_array(pa(w('48'), 'visa', 10))));
select one('r_legacy', 'sale.recheckout', u('11'), rc(w('40'), ib(), 500, '[]', jsonb_build_array(pa(w('49'), 'cash + instapay', 10))));
select ok(vi('r_tender') = '{unknown_tender}' and vi('r_legacy') = '{unknown_tender}' and (sal(w('40'))).amount_paid = 220,
  'M23 unknown_tender: new money on an unknown tender, and on a legacy one (030:610-617)');
select one('r_noneg', 'store.update', u('11'), '{"allow_negative_stock": false}');
select one('r_neg', 'sale.recheckout', u('11'), rc(w('40'), ib2(), 600,
  jsonb_build_array(jsonb_build_object('id', w('4b'), 'product_id', w('05'), 'qty', -5)), '[]'));
select one('r_neg_ok', 'store.update', u('11'), '{"allow_negative_stock": true}');
select ok(vi('r_neg') = '{negative_stock}' and qty(w('05')) = -4,
  'M24 negative_stock: the re-checkout''s new units took the shelf below zero');
select one('r_price', 'sale.recheckout', u('11'), rc(w('40'),
  jsonb_build_array(li(w('41'), w('01'), 1, 490), li(w('4a'), w('05'), 5, 20)), 590, '[]', '[]'));
select ok(vi('r_price') = '{price_changed}' and (sal(w('40'))).net_amount = 590, 'M25 price_changed on a re-checkout');
select one('r_hdr', 'sale.recheckout', u('11'), rc(w('40'), ib2(), 550, '[]', '[]',
  '{"total_amount": 550, "discount": 0, "net_amount": 550}'));
select ok(vi('r_hdr') = '{header_rule}', 'M26 header_rule on a re-checkout');
select one('r_over', 'sale.recheckout', u('11'), rc(w('40'), ib2(), 600, '[]', jsonb_build_array(pa(w('4c'), 'cash', 500))));
select ok(vi('r_over') = '{overpaid}' and (sal(w('40'))).amount_paid = 720, 'M27 overpaid on a re-checkout');
select one('r_div', 'sale.recheckout', u('11'), rc(w('40'), ib2(), 720, '[]', '[]', '{"expect": {"paid": 1}}'));
select ok(vi('r_div') = '{divergence}' and (det('r_div') -> 'divergence' ->> 'paid')::numeric = 720,
  'M28 divergence: expect.paid is not the server ledger (both in detail)');
select one('r_exceed', 'sale.recheckout', u('11'), rc(w('40'), ib2(), 720, '[]',
  jsonb_build_array(pa(w('4d'), 'wallet', -10), pa(w('4e'), 'cash', 10))));
select ok(vi('r_exceed') = '{refund_exceeds_tender}' and (led(w('40')) ->> 'wallet')::numeric = -10,
  'M29 refund_exceeds_tender: a re-checkout takes a tender below zero');
select one('r_mov', 'sale.recheckout', u('11'), rc(w('40'),
  jsonb_build_array(li(w('41'), w('01'), 2, 500), li(w('4a'), w('05'), 5, 20)), 1100, '[]', '[]'));
select ok(vi('r_mov') = '{divergence}' and det('r_mov') -> 'movements' -> 0 ->> 'rule' = '-1',
  'M30 divergence: the movements are not the change of quantity (030:657-675)');

-- ---- flags of sale.header, sale.exams, sale.lab_status ----
select one('m_s2', 'sale.create', u('11'), sc(w('50'), '340030', jsonb_build_array(li(w('51'), w('03'), 1, 300, 0, w('52'))),
  jsonb_build_array(pa(w('53'), 'cash', 100)), 300,
  jsonb_build_object('lab_status', 'Not Started', 'exams', jsonb_build_array(jsonb_build_object('id', w('54'), 'exam_type', 'distance')))));
select cl('h_lab', 'sale.header', jsonb_build_object('sale_id', w('50'), 'lab_status', 'In Lab'));
select ok(st('m_s2') = 'ok' and vi('h_lab') = '{perm:lab.edit}' and (sal(w('50'))).lab_status = 'In Lab',
  'M31 perm:lab.edit: a clerk''s header edit that changes the lab status');
select one('h_rx', 'sale.header', u('11'), jsonb_build_object('sale_id', w('50'), 'rx_image_path', 'store/a/orders/rx-s2.jpg'));
select cl('h_photo', 'sale.header', jsonb_build_object('sale_id', w('50'), 'rx_image_path', 'store/a/orders/rx-s2b.jpg'));
select ok(st('h_rx') = 'ok' and vi('h_photo') = '{photo_replace_not_admin}', 'M32 photo_replace_not_admin on sale.header');
select one('h_void', 'sale.header', u('11'), jsonb_build_object('sale_id', w('10'), 'doctor_name', 'Dr V'));
select one('e_void', 'sale.exams', u('11'), jsonb_build_object('sale_id', w('10'), 'exams', '[]'::jsonb));
select one('l_void', 'sale.lab_status', u('11'), jsonb_build_object('sale_id', w('10'), 'status', 'Ready'));
select ok(vi('h_void') = '{edit_voided}' and vi('e_void') = '{edit_voided}' and vi('l_void') = '{edit_voided}'
          and (select doctor_name = 'Dr V' and lab_status = 'Ready' and lab_ready_at = now() from public.sales where id = w('10'))
          and not exists (select 1 from public.order_examinations where sale_id = w('10')),
  'M33 edit_voided on sale.header, sale.exams and sale.lab_status of a voided sale (applied)');
update public.store_licenses set features = '{"lab": false}' where store_id = s_a();
select one('l_feat', 'sale.lab_status', u('11'), jsonb_build_object('sale_id', w('50'), 'status', 'Ready'));
select ok(vi('l_feat') = '{feature:lab}' and (sal(w('50'))).lab_status = 'Ready',
  'M34 feature:lab: sale.lab_status under a licence with features.lab = false (flagged, applied)');
select _as(u('11'));
select ok(public.license_feature('lab') = _lf027('lab') and not public.license_feature('lab'),
  'M35 ...and license_feature(''lab'') answers a staff session exactly as 027 did');
select _as(u('71'));
update public.store_licenses set features = '{}' where store_id = s_a();

-- ---- flags of payment.collect and sale.refund, on S2 (net 300, paid 100) ----
select one('p_tender', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('50'), 'lines', jsonb_build_array(pa(w('55'), 'visa', 10))));
select ok(vi('p_tender') = '{unknown_tender}', 'M36 unknown_tender on payment.collect');
select one('p_div', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('50'), 'lines', jsonb_build_array(pa(w('57'), 'cash', 1)),
  'expect', jsonb_build_object('paid', 0)));
select ok(vi('p_div') = '{divergence}', 'M37 divergence on payment.collect');
select one('p_over', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('50'), 'lines', jsonb_build_array(pa(w('56'), 'cash', 500))));
select ok(vi('p_over') = '{overpaid}' and (sal(w('50'))).amount_paid = 611, 'M38 overpaid: a collection above the balance (029:812)');
select one('f_exceed', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('50'), 'row', pa(w('58'), 'card', 5)));
select ok(vi('f_exceed') = '{refund_exceeds_tender}' and (det('f_exceed') -> 'refund_exceeds_tender' ->> 'held')::numeric = 0,
  'M39 refund_exceeds_tender: a refund on a tender that holds nothing (028:143-151)');
select one('f_div', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('50'), 'row', pa(w('59'), 'cash', 1),
  'expect', jsonb_build_object('tenders', jsonb_build_array(jsonb_build_object('method', 'Cash ', 'amount', 9999)))));
select ok(vi('f_div') = '{divergence}', 'M40 divergence on sale.refund (tenders grouped by tender_key)');
select one('f_perm', 'sale.refund', u('13'), jsonb_build_object('sale_id', w('50'), 'row', pa(w('5a'), 'cash', 1)));
select ok(vi('f_perm') = '{perm:history.refund}' and exists (select 1 from public.sale_payments where id = w('5a') and recorded_by = u('13')),
  'M41 perm:history.refund (the kind table''s code) for the cashier; applied, attributed to the cashier');

-- ---- flags of sale.void ----
select one('m_s10', 'sale.create', u('11'), sc(w('60'), '340040', jsonb_build_array(li(w('61'), w('01'), 1, 500, 0, w('62'))),
  jsonb_build_array(pa(w('63'), 'cash', 500)), 500));
select one('v_deriv', 'sale.void', u('11'), jsonb_build_object('sale_id', w('60'), 'reason', 'x',
  'refunds', jsonb_build_array(pa(w('64'), 'card', -500))));
select ok(st('m_s10') = 'ok' and vi('v_deriv') = '{void_derivation_differs}' and led(w('60')) = '{"cash": 500, "card": -500}'::jsonb
          and (det('v_deriv') -> 'void_derivation' -> 'refunds' ->> 'cash')::numeric = -500 and qty(w('01')) = 2,
  'M42 void_derivation_differs: refunds on another tender than the one held; no restock sent, none made');
select one('m_s11', 'sale.create', u('11'), sc(w('65'), '340041', jsonb_build_array(li(w('66'), w('01'), 1, 500, 0, w('67'))),
  jsonb_build_array(pa(w('68'), 'cash', 500)), 500));
select one('v_nz', 'sale.void', u('11'), jsonb_build_object('sale_id', w('65'), 'refunds', jsonb_build_array(pa(w('69'), 'cash', -400))));
select ok(vi('v_nz') = '{void_derivation_differs,void_not_zero}' and (det('v_nz') ->> 'void_not_zero')::numeric = 100,
  'M43 void_not_zero (it cannot fire alone: rows that match the derivation always end at 0 under amount_paid >= 0)');
select one('m_s12', 'sale.create', u('11'), sc(w('6a'), '340042', jsonb_build_array(li(w('6b'), w('01'), 1, 500, 0, w('6c'))),
  jsonb_build_array(pa(w('6d'), 'cash', 200)), 500));
select one('v_div', 'sale.void', u('11'), jsonb_build_object('sale_id', w('6a'), 'refunds', jsonb_build_array(pa(w('6e'), 'cash', -200)),
  'restock', jsonb_build_array(jsonb_build_object('id', w('6f'), 'product_id', w('01'), 'qty', 1)), 'expect', '{"paid": 1}'::jsonb));
select ok(vi('v_div') = '{divergence}' and (sal(w('6a'))).voided_at = now(), 'M44 divergence on sale.void');
select one('m_s13', 'sale.create', u('11'), sc(w('b0'), '340043', jsonb_build_array(li(w('b1'), w('03'), 1, 300, 0, w('b2'))),
  jsonb_build_array(pa(w('b3'), 'cash', 300)), 300));
select one('v_rest', 'sale.void', u('11'), jsonb_build_object('sale_id', w('b0'), 'refunds', jsonb_build_array(pa(w('b4'), 'cash', -300)),
  'restock', jsonb_build_array(jsonb_build_object('id', w('b5'), 'product_id', w('03'), 'qty', 2))));
select ok(vi('v_rest') = '{void_derivation_differs}' and (det('v_rest') -> 'void_derivation' -> 'restock' ->> w('03')::text)::int = 1
          and (sal(w('b0'))).amount_paid = 0,
  'M45 void_derivation_differs: a restock that is not the sale''s lines');

-- ---- shift.close: the recompute equals the PC figures; z_mismatch ----
-- t3: 10:00 UTC three days ago, so close_shift's window rounding (to the
-- next midnight, 016:35-43) cannot reach another op of this test.
create table _t3 (t timestamptz);
insert into _t3 values (((date_trunc('day', now() at time zone 'UTC') - interval '3 days') + interval '10 hours') at time zone 'UTC');
create function t3() returns timestamptz language sql stable as $$ select t from _t3 $$;
select one('z_sale', 'sale.create', u('11'), sc(w('90'), '340050', jsonb_build_array(li(w('91'), w('03'), 1, 300, 0, w('92'))),
  jsonb_build_array(pa(w('93'), 'cash', 200), pa(w('94'), 'card', 100)), 300), t3());
select one('z_ref', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('90'), 'row', pa(w('95'), 'cash', 50)),
           t3() + interval '10 minutes');
select one('z_ok', 'shift.close', u('11'), jsonb_build_object('id', w('96'), 'from_at', t3() - interval '1 hour',
  'to_at', t3() + interval '1 hour', 'counted_cash', 160, 'expected_cash', 150,
  'expected_by_tender', jsonb_build_object('cash', 150, 'card', 100), 'expected_total', 250, 'order_count', 1,
  'prescription_count', 0, 'void_count', 0, 'refund_total', 50, 'lab_delivered', 0, 'variance', 10, 'note', ' end of day '));
select ok(vi('z_sale') = '{clock_back}' and vi('z_ref') = '{clock_back}' and st('z_ok') = 'ok'
          and (select closed_by = u('11') and closed_at = now() and from_at = t3() - interval '1 hour' and counted_cash = 160
                      and expected_cash = 150 and expected_total = 250 and variance = 10 and refund_total = 50 and order_count = 1
                      and expected_by_tender = '{"cash": 150, "card": 100}'::jsonb and note = 'end of day' and store_id = s_a()
                 from public.shift_closes where id = w('96')),
  'M46 shift.close: the server''s _z_report recompute equals the PC figures (ok); stored verbatim, closed_by the actor at t');
select one('z_bad', 'shift.close', u('11'), jsonb_build_object('id', w('97'), 'from_at', t3() - interval '2 hours',
  'to_at', t3() + interval '1 hour', 'counted_cash', 150, 'expected_cash', 999,
  'expected_by_tender', jsonb_build_object('cash', 150, 'card', 100), 'expected_total', 250, 'order_count', 1,
  'refund_total', 50));
select ok(vi('z_bad') = '{z_mismatch}' and (det('z_bad') -> 'z_mismatch' -> 'server' ->> 'expected_cash')::numeric = 150
          and (det('z_bad') -> 'z_mismatch' -> 'pc' ->> 'expected_cash')::numeric = 999
          and (select expected_cash = 999 and variance = -849 from public.shift_closes where id = w('97')),
  'M47 z_mismatch: both figure sets in detail, the PC''s stored');

-- ---- purchases ----
select one('m_pu', 'purchase.upsert', u('11'), jsonb_build_object('id', w('80'), 'supplier_id', u('e6'), 'total_amount', 400,
  'amount_paid', 0, 'items', jsonb_build_array(
    jsonb_build_object('id', w('81'), 'product_id', w('01'), 'qty', 2, 'unit_cost', 150, 'total_cost', 300),
    jsonb_build_object('id', w('82'), 'product_id', w('03'), 'qty', 1, 'unit_cost', 100, 'total_cost', 100))));
select ok(st('m_pu') = 'ok'
          and (select created_at = now() and purchase_date = now() and total_amount = 400 and store_id = s_a()
                 from public.purchases where id = w('80'))
          and (select count(*) = 2 and bool_and(received_at is null and created_at = now() and store_id = s_a())
                 from public.purchase_items where purchase_id = w('80')),
  'M48 purchase.upsert ok: the header and its lines at t');
select one('m_pp', 'purchase.payment.add', u('11'), jsonb_build_object('id', w('83'), 'purchase_id', w('80'), 'amount', 100, 'note', 'deposit'));
select ok(st('m_pp') = 'ok'
          and (select amount = 100 and paid_at = (now() at time zone 'Africa/Cairo')::date and created_at = now() and store_id = s_a()
                 from public.purchase_payments where id = w('83')),
  'M49 purchase.payment.add ok: paid_at is the store''s day of t');
create table _cost as
select round((qty(w('01')) * 200 + 2 * 150)::numeric / (qty(w('01')) + 2), 2) as c, qty(w('01')) as q;
select one('m_rcv', 'purchase.receive', u('11'), jsonb_build_object('purchase_id', w('80'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', w('81'), 'movement_id', w('84'))),
  'cost_after', jsonb_build_object(w('01')::text, (select c from _cost))));
select ok(st('m_rcv') = 'ok' and qty(w('01')) = (select q from _cost) + 2
          and (select cost_price from public.inventory where id = w('01')) = (select c from _cost)
          and (select qty = 2 and type = 'purchase' and ref_no = w('80')::text and created_at = now()
                 from public.stock_movements where id = w('84'))
          and (select received_at from public.purchase_items where id = w('81')) = now()
          and (select received_at from public.purchase_items where id = w('82')) is null,
  'M50 purchase.receive ok: a purchase movement at t, the weighted cost (032), received_at = t, the other line untouched');
select one('m_rcv_cost', 'purchase.receive', u('11'), jsonb_build_object('purchase_id', w('80'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', w('82'), 'movement_id', w('85'))),
  'cost_after', jsonb_build_object(w('03')::text, 1.23)));
select ok(vi('m_rcv_cost') = '{cost_mismatch}' and (select cost_price from public.inventory where id = w('03')) = 1.23
          and (det('m_rcv_cost') -> 'cost_mismatch' -> 0 ->> 'server')::numeric = 100,
  'M51 cost_mismatch: the PC''s cost stored, the server''s in detail');
select one('m_pu_ed', 'purchase.upsert', u('11'), jsonb_build_object('id', w('80'), 'supplier_id', u('e6'), 'total_amount', 405,
  'items', jsonb_build_array(
    jsonb_build_object('id', w('81'), 'product_id', w('01'), 'qty', 2, 'unit_cost', 150, 'total_cost', 300),
    jsonb_build_object('id', w('86'), 'product_id', w('05'), 'qty', 1, 'unit_cost', 5, 'total_cost', 5))));
select ok(st('m_pu_ed') = 'ok' and (select total_amount from public.purchases where id = w('80')) = 405
          and (select count(*) from public.purchase_items where purchase_id = w('80')) = 3
          and (select received_at is not null from public.purchase_items where id = w('82')),
  'M52 purchase.upsert edit: a new line; received lines (sent unchanged, or not sent) are kept');
select one('m_pu_st', 'purchase.upsert', u('11'), jsonb_build_object('id', w('80'), 'supplier_id', u('e6'), 'total_amount', 405,
  'items', jsonb_build_array(jsonb_build_object('id', w('81'), 'product_id', w('01'), 'qty', 3, 'unit_cost', 150, 'total_cost', 450))));
select ok(hc('m_pu_st') = 'STATE' and hm('m_pu_st') like 'state: purchase item % is already received'
          and (select qty from public.purchase_items where id = w('81')) = 2,
  'M53 STATE: purchase.upsert changing a received line');
select cl('m_pu_cr', 'purchase.upsert', jsonb_build_object('id', w('87'), 'supplier_id', u('e6'), 'total_amount', 10));
select one('m_pu_eda', 'purchase.upsert', u('13'), jsonb_build_object('id', w('87'), 'supplier_id', u('e6'), 'total_amount', 20));
select ok(vi('m_pu_cr') = '{perm:suppliers.create}' and vi('m_pu_eda') = '{perm:suppliers.edit}' and (rg()).held_seq is null
          and (select total_amount from public.purchases where id = w('87')) = 20,
  'M54 perm:suppliers.create / perm:suppliers.edit: purchase.upsert''s target-dependent codes');
select one('m_pd', 'purchase.delete', u('11'), jsonb_build_object('id', w('87')));
select one('m_pd_mis', 'purchase.delete', u('11'), jsonb_build_object('id', w('8f')));
select one('m_ppd', 'purchase.payment.delete', u('11'), jsonb_build_object('id', w('83')));
select one('m_ppd_mis', 'purchase.payment.delete', u('11'), jsonb_build_object('id', w('8e')));
select ok(st('m_pd') = 'ok' and not exists (select 1 from public.purchases where id = w('87'))
          and st('m_ppd') = 'ok' and not exists (select 1 from public.purchase_payments where id = w('83'))
          and vi('m_pd_mis') = '{delete_missing}' and vi('m_ppd_mis') = '{delete_missing}',
  'M55 purchase.delete and purchase.payment.delete ok, and delete_missing for each');

-- ---- STATE holds: a missing sale (every sale.* kind and payment.collect),
-- a voided one where a live one is needed, no lab order, purchase.receive ----
select one('s_rc', 'sale.recheckout', u('11'), rc(w('fe'), ib(), 500, '[]', '[]'));
select ok(hc('s_rc') = 'STATE' and hm('s_rc') = format('state: sale %s is missing', w('fe')), 'M56 STATE: sale.recheckout of a missing sale');
select one('s_hdr', 'sale.header', u('11'), jsonb_build_object('sale_id', w('fe'), 'doctor_name', 'x'));
select ok(hc('s_hdr') = 'STATE' and hm('s_hdr') like 'state: sale % is missing', 'M57 STATE: sale.header of a missing sale');
select one('s_exm', 'sale.exams', u('11'), jsonb_build_object('sale_id', w('fe'), 'exams', '[]'::jsonb));
select ok(hc('s_exm') = 'STATE' and hm('s_exm') like 'state: sale % is missing', 'M58 STATE: sale.exams of a missing sale');
select one('s_lab', 'sale.lab_status', u('11'), jsonb_build_object('sale_id', w('fe'), 'status', 'Ready'));
select ok(hc('s_lab') = 'STATE' and hm('s_lab') like 'state: sale % is missing', 'M59 STATE: sale.lab_status of a missing sale');
select one('s_col', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('fe'), 'lines', jsonb_build_array(pa(w('e0'), 'cash', 1))));
select ok(hc('s_col') = 'STATE' and hm('s_col') like 'state: sale % is missing'
          and not exists (select 1 from public.sale_payments where id = w('e0')),
  'M60 STATE: payment.collect on a missing sale (nothing written)');
select one('s_ref', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('fe'), 'row', pa(w('e1'), 'cash', 1)));
select ok(hc('s_ref') = 'STATE' and hm('s_ref') like 'state: sale % is missing', 'M61 STATE: sale.refund of a missing sale');
select one('s_void', 'sale.void', u('11'), jsonb_build_object('sale_id', w('fe')));
select ok(hc('s_void') = 'STATE' and hm('s_void') like 'state: sale % is missing', 'M62 STATE: sale.void of a missing sale');
select one('s_rc_v', 'sale.recheckout', u('11'), rc(w('10'), ib(), 500, '[]', '[]'));
select one('s_col_v', 'payment.collect', u('11'), jsonb_build_object('sale_id', w('10'), 'lines', jsonb_build_array(pa(w('e2'), 'cash', 1))));
select one('s_ref_v', 'sale.refund', u('11'), jsonb_build_object('sale_id', w('10'), 'row', pa(w('e3'), 'cash', 1)));
select one('s_void_v', 'sale.void', u('11'), jsonb_build_object('sale_id', w('10')));
select ok(hc('s_void_v') = 'STATE' and hm('s_void_v') = format('state: sale %s is voided', w('10'))
          and (select count(*) from public.register_ops where store_id = s_a() and seq = sq('s_rc_v')) = 0
          and sq('s_rc_v') = sq('s_void_v') and not exists (select 1 from public.sale_payments where id in (w('e2'), w('e3'))),
  'M63 STATE: re-checkout, collect, refund and void of a voided sale (each held at the same seq, nothing written)');
select one('s_nolab', 'sale.lab_status', u('11'), jsonb_build_object('sale_id', w('40'), 'status', 'Ready'));
select ok(hc('s_nolab') = 'STATE' and hm('s_nolab') like 'state: sale % has no lab order', 'M64 STATE: sale.lab_status of a sale with no lab order');
select one('s_pr', 'purchase.receive', u('11'), jsonb_build_object('purchase_id', w('fd'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', w('81'), 'movement_id', w('e4'))), 'cost_after', '{}'::jsonb));
select ok(hc('s_pr') = 'STATE' and hm('s_pr') like 'state: purchase % is missing', 'M65 STATE: purchase.receive of a missing purchase');
select one('s_pr2', 'purchase.receive', u('11'), jsonb_build_object('purchase_id', w('80'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', w('81'), 'movement_id', w('e4'))),
  'cost_after', jsonb_build_object(w('01')::text, 1)));
select ok(hc('s_pr2') = 'STATE' and hm('s_pr2') like 'state: purchase item % is already received'
          and not exists (select 1 from public.stock_movements where id = w('e4')),
  'M66 STATE: purchase.receive of a line already received');
select one('m_clear', 'note.upsert', u('11'), jsonb_build_object('id', w('e5'), 'body', 'after the holds'));
select ok(st('m_clear') = 'ok' and (rg()).held_seq is null, 'M67 (a good op at the held seq clears the hold)');

-- ---- attribution: every actor column is the op's actor ----
select ok(not exists (select 1 from public.sale_payments sp
                       where sp.store_id = s_a() and (sp.recorded_by is null
                             or not exists (select 1 from public.users x where x.id = sp.recorded_by and x.store_id = s_a())))
          and (select bool_and(user_id = u('11')) from public.sales where store_id = s_a())
          and (select bool_and(voided_by = u('11')) from public.sales where store_id = s_a() and voided_at is not null)
          and (select bool_and(closed_by = u('11')) from public.shift_closes where store_id = s_a())
          and (select bool_and(actor = u('11') and event_at = now() and via_register) and count(*) = 2
                 from public.audit_log where table_name = 'sale_payments' and row_id in (w('15')::text, w('16')::text))
          and (select bool_and(actor = u('14')) from public.audit_log where table_name = 'sale_payments' and row_id = w('45')::text),
  'M68 attribution: user_id, recorded_by, voided_by, closed_by and audit_log.actor are the op''s actor, never the register login');

select _as(u('71'));
insert into _r select 'h_mal', ing(jsonb_build_array(
  op(nx(),     'note.upsert', u('11'), jsonb_build_object('id', u('b1'), 'body', 'before the hold')),
  op(nx() + 1, 'foo.bar',     u('11'), '{}'),
  op(nx() + 2, 'note.upsert', u('11'), jsonb_build_object('id', u('b2'), 'body', 'after the hold'))));
select ok((select (j -> 'held' ->> 's')::bigint = (j ->> 'acked_seq')::bigint + 1 and j -> 'held' ->> 'code' = 'MAL'
             from _r where k = 'h_mal')
          and (rg()).held_code = 'MAL' and (rg()).held_op ->> 'k' = 'foo.bar'
          and exists (select 1 from public.notes where id = u('b1'))
          and not exists (select 1 from public.notes where id = u('b2')),
  'H1 MAL (unknown kind): held, the earlier op kept, the queue stops (the later op not applied)');
select one('h_retry', 'note.upsert', u('11'), jsonb_build_object('id', u('b2'), 'body', 'after the hold'));
select ok(st('h_retry') = 'ok' and (rg()).held_seq is null and (rg()).held_code is null and (rg()).held_op is null
          and (select j -> 'held' from _r where k = 'h_retry') = 'null'::jsonb,
  'H2 a successful retry at the held seq clears held_*');
select one('h_v0', 'note.upsert', u('11'), jsonb_build_object('id', u('b3'), 'body', 'x'), now(), null, '{"v": 0}');
select ok((rg()).held_code = 'MAL' and (rg()).held_seq = sq('h_v0'), 'H3 MAL: v below the supported range');
select one('h_mdtbl', 'metadata.upsert', u('11'), jsonb_build_object('table', 'users', 'id', u('b4'), 'name', 'x'));
select ok((rg()).held_code = 'MAL' and (rg()).held_error ->> 'message' = 'malformed: table',
  'H4 MAL: a metadata table that is not lens_types/frame_colors/frame_types');
select one('h_vmax', 'note.upsert', u('11'), jsonb_build_object('id', u('b3'), 'body', 'x'), now(), null, '{"v": 2}');
select ok((select (j ->> 'server_upgrade_required')::boolean and (j ->> 'acked_seq')::bigint = sq('h_vmax') - 1 from _r where k = 'h_vmax')
          and (rg()).held_code = 'MAL' and (rg()).held_seq = sq('h_vmax'),
  'H5 v above max_v: server_upgrade_required, not a hold (the earlier hold is untouched)');
insert into _r select 'h_int', ing(jsonb_build_array(
  op(nx(),     'note.upsert',    u('11'), jsonb_build_object('id', u('b3'), 'body', 'kept')),
  op(nx() + 1, 'product.upsert', u('11'), jsonb_build_object('id', u('b5'), 'name', 'Frame H', 'sale_price', 10,
                                                            'initial', jsonb_build_object('movement_id', u('e3'), 'qty', 3)))));
select ok((rg()).held_code = 'INT' and (rg()).held_error ->> 'constraint' = 'stock_movements_pkey'
          and (rg()).held_error ->> 'sqlstate' = '23505'
          and exists (select 1 from public.notes where id = u('b3'))
          and not exists (select 1 from public.inventory where id = u('b5')),
  'H6 INT (a unique violation): the held op''s own product row is rolled back, the earlier op in the batch kept');
select ok((rg()).held_seq is not null and (rg()).held_at = now() and (rg()).last_seq = (rg()).held_seq - 1,
  'H7 held_seq is the next seq, held_at stamped');
select one('h_int_fix', 'product.upsert', u('11'), jsonb_build_object('id', u('b5'), 'name', 'Frame H', 'sale_price', 10,
                                                                     'initial', jsonb_build_object('movement_id', u('b6'), 'qty', 3)));
select ok(st('h_int_fix') = 'ok' and (rg()).held_seq is null and (select stock_qty from public.inventory where id = u('b5')) = 3,
  'H8 ...the fixed op applies and the hold clears');
select one('h_state', 'supplier.delete', u('11'), jsonb_build_object('id', u('d1')));
select ok((rg()).held_code = 'STATE' and exists (select 1 from public.suppliers where id = u('d1'))
          and (select j -> 'held' ->> 'code' from _r where k = 'h_state') = 'STATE',
  'H9 STATE: deleting a supplier that has purchases');

-- ===== P: the vendor park ==================================================
set role authenticated; select _as(u('11'));
select throws_ok(format('select public.register_resolve_held(%L, %s, %L)', s_a(), sq('h_state'), 'not mine'),
  '42501', null, 'P1 only a platform admin parks a held op');
select _as(u('61'));
select throws_ok(format('select public.register_resolve_held(%L, %s, %L)', s_a(), sq('h_state') + 1, 'wrong seq'),
  '55000', null, 'P2 ...and only the op that is held');
insert into _r select 'park', public.register_resolve_held(s_a(), sq('h_state'), 'supplier kept: owner decides');
reset role; select _as(u('71'));
select ok((select status = 'parked' and kind = 'supplier.delete' and payload = jsonb_build_object('id', u('d1'))
                  and detail ->> 'held_code' = 'STATE'
             from public.register_ops where store_id = s_a() and seq = sq('h_state'))
          and (rg()).last_seq = sq('h_state') and (rg()).held_seq is null and (rg()).parked_total = 1
          and exists (select 1 from public.audit_log where table_name = 'register_ops' and action = 'park'
                         and row_id = sq('h_state')::text and actor = u('61') and store_id = s_a()),
  'P3 parked: a parked row with the held op, last_seq past it, held cleared, parked_total 1, audited');

-- A FAULT and a transient error, through test-only kinds (rolled back).
create function _t_fault(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text) returns text[]
language plpgsql as $$ begin raise exception 'boom'; end $$;
create function _t_deadlock(p_store uuid, p_actor uuid, p_at timestamptz, p jsonb, p_kind text) returns text[]
language plpgsql as $$ begin raise exception 'deadlock (test)' using errcode = '40P01'; end $$;
insert into public._register_kind_perms (kind, writer) values ('test.fault', '_t_fault'), ('test.deadlock', '_t_deadlock');
select one('h_dead', 'test.deadlock', u('11'), '{}');
select ok((select (j ->> 'retry')::boolean and (j ->> 'acked_seq')::bigint = sq('h_dead') - 1 from _r where k = 'h_dead')
          and (rg()).held_seq is null,
  'H10 40P01: retry true, no hold, nothing acked');
select one('h_fault', 'test.fault', u('11'), '{}');
select ok((rg()).held_code = 'FAULT' and (rg()).held_error ->> 'message' = 'boom',
  'H11 FAULT: any other error');
select one('h_fault_fix', 'note.upsert', u('11'), jsonb_build_object('id', u('b7'), 'body', 'x'));
select ok(st('h_fault_fix') = 'ok' and (rg()).held_seq is null, 'H12 ...cleared by the next good op at that seq');
select ok(current_setting('lensy.ingest', true) = '' and current_setting('lensy.actor', true) = ''
          and current_setting('lensy.detail', true) = '' and (select count(*) from public.register_bypass) = 0,
  'H13 GUCs and the token are cleared after held and transient batches too');

-- ===== R: refusals =========================================================
update public.store_registers set alert = null, alert_at = null where store_id = s_a();
insert into _r select 'r_actor', ing(jsonb_build_array(
  op(nx(),     'note.upsert', u('21'), jsonb_build_object('id', u('a3'), 'body', 'forged'), now(), u('5a')),
  op(nx() + 1, 'note.upsert', u('11'), jsonb_build_object('id', u('a4'), 'body', 'genuine'))));
select ok((select status = 'refused' and violations = '{foreign_actor}' from public.register_ops
            where store_id = s_a() and seq = (select (j ->> 'acked_seq')::bigint - 1 from _r where k = 'r_actor'))
          and not exists (select 1 from public.notes where id = u('a3'))
          and exists (select 1 from public.notes where id = u('a4'))
          and (rg()).alert = 'refused' and (rg()).alert_at = now(),
  'R1 foreign_actor: refused, nothing written, alert set, and the queue continued');
select ok((select j -> 'results' from _r where k = 'r_actor')
          = jsonb_build_array(jsonb_build_object('s', (select (j ->> 'acked_seq')::bigint - 1 from _r where k = 'r_actor'),
                                                 'st', 'refused', 'v', '["foreign_actor"]'::jsonb)),
  'R2 ...reported in results');
select one('r_sid', 'note.upsert', u('11'), jsonb_build_object('id', u('a5'), 'body', 'x'), now(), null, '{"sid": null}');
select ok(st('r_sid') = 'refused' and vi('r_sid') = '{no_session_sid}' and not exists (select 1 from public.notes where id = u('a5')),
  'R3 no_session_sid');
select one('r_foreign', 'customer.upsert', u('11'), jsonb_build_object('id', u('9b'), 'name', 'Stolen'));
select ok(st('r_foreign') = 'refused' and vi('r_foreign') = '{foreign_id}'
          and (select name = 'Customer B34' and store_id = s_b() from public.customers where id = u('9b')),
  'R4 foreign_id: another store''s customer id; that row is unchanged');
insert into _r select 'r_money', ing((select jsonb_agg(op(nx() + n - 1, 'noop', u('11'),
                                                         jsonb_build_object('skipped', op(0, k.kind, u('11'), '{}'), 'reason', 'skip', 'by', u('11')))
                                               order by n)
                                     from (select kind, row_number() over (order by kind) n
                                             from public._register_kind_perms where money) k));
select ok((select count(*) = 10 and bool_and(o.status = 'refused' and o.violations = '{money_skip_forbidden}')
             from public.register_ops o
            where o.store_id = s_a() and o.kind = 'noop' and o.status <> 'skipped')
          and (select count(*) from public.register_ops o where o.store_id = s_a() and o.kind = 'noop'
                  and o.payload -> 'skipped' ->> 'k' in (select kind from public._register_kind_perms where money)) = 10
          and (select (j ->> 'acked_seq')::bigint from _r where k = 'r_money') = (rg()).last_seq,
  'R5 a noop wrapping each of the 10 MONEY_KINDS kinds: refused money_skip_forbidden, all acked');

-- ===== D: dup, gap, dup_import =============================================
select ok((select (j ->> 'dup')::int = 1 and j -> 'results' = '[]'::jsonb
             from (select ing(jsonb_build_array((select j -> '_op' from _r where k = 'h_fault_fix')))) x(j))
          and (rg()).last_seq = (select (j ->> 'acked_seq')::bigint from _r where k = 'r_money'),
  'D1 the same op again (same s and op id): dup, nothing changes');
select ok((select (j ->> 'acked_seq')::bigint = (rg()).last_seq and j -> 'results' -> 0 ->> 'st' = 'gap'
             from (select ing(jsonb_build_array(op(nx() + 1, 'note.upsert', u('11'), jsonb_build_object('id', u('a6'), 'body', 'x'))))) x(j))
          and not exists (select 1 from public.notes where id = u('a6')),
  'D2 a gap: stopped, acked_seq unchanged, not applied');
select one('d_imp', 'note.upsert', u('11'), jsonb_build_object('id', u('a7'), 'body', 'x'), now(), null,
           jsonb_build_object('i', (select j -> '_op' ->> 'i' from _r where k = 'k_note_new')));
select ok((select status = 'dup_import' and op_id is null and (detail ->> 'dup_of')::bigint = sq('k_note_new')
             from public.register_ops where store_id = s_a() and seq = sq('d_imp'))
          and (rg()).last_seq = sq('d_imp') and not exists (select 1 from public.notes where id = u('a7')),
  'D3 an op id already logged at another seq: dup_import, last_seq advanced, nothing applied');
select ok((select (j ->> 'dup')::int = 1 and (j ->> 'current')::boolean
             from (select ing(jsonb_build_array((select j -> '_op' from _r where k = 'd_imp')))) x(j)),
  'D4 resending the dup_import op is a dup, not a seq conflict');

-- ===== B: the budget =======================================================
select set_config('lensy.ingest_budget_ms', '0', true);
insert into _r select 'b0', ing(jsonb_build_array(
  op(nx(),     'note.upsert', u('11'), jsonb_build_object('id', u('a8'), 'body', 'b1')),
  op(nx() + 1, 'note.upsert', u('11'), jsonb_build_object('id', u('a9'), 'body', 'b2')),
  op(nx() + 2, 'note.upsert', u('11'), jsonb_build_object('id', u('aa'), 'body', 'b3'))));
select ok((select (j ->> 'more')::boolean and (j ->> 'acked_seq')::bigint = (rg()).last_seq from _r where k = 'b0')
          and exists (select 1 from public.notes where id = u('a8'))
          and not exists (select 1 from public.notes where id = u('a9')),
  'B1 budget 0: one op per call, more true');
select set_config('lensy.ingest_budget_ms', '999999', true);
insert into _r select 'b1', ing(jsonb_build_array(
  op(nx(),     'note.upsert', u('11'), jsonb_build_object('id', u('a9'), 'body', 'b2')),
  op(nx() + 1, 'note.upsert', u('11'), jsonb_build_object('id', u('aa'), 'body', 'b3'))));
select ok((select not (j ->> 'more')::boolean from _r where k = 'b1') and exists (select 1 from public.notes where id = u('aa')),
  'B2 a large setting is capped (at most 3000 ms), and a short batch completes with more false');

-- The 2,000-op drain, in store C (its log starts at 0).
create table _drain (s integer primary key, op jsonb);
insert into _drain
select g, jsonb_build_object('s', g, 'i', gen_random_uuid(), 'k', 'note.upsert', 'v', 1, 'a', u('31'), 'sid', u('5d'),
                             't', to_jsonb(now()), 'p', jsonb_build_object('id', gen_random_uuid(), 'body', 'drain ' || g))
  from generate_series(1, 2000) g;
select set_config('lensy.ingest_budget_ms', '0', true);
select _as(u('73'));
do $$
declare
  v_acked integer := 0;
  v_calls integer := 0;
  v       jsonb;
begin
  while v_acked < 2000 and v_calls < 2100 loop
    v := public.register_ingest(1, 1, 2000 - v_acked, null,
           (select jsonb_agg(d.op order by d.s) from _drain d where d.s > v_acked and d.s <= v_acked + 5));
    v_acked := (v ->> 'acked_seq')::integer;
    v_calls := v_calls + 1;
  end loop;
  insert into _r values ('drain', jsonb_build_object('calls', v_calls, 'acked', v_acked, 'more', v -> 'more'));
end $$;
select set_config('lensy.ingest_budget_ms', '', true);
select is((select j from _r where k = 'drain'), '{"calls": 2000, "acked": 2000, "more": false}'::jsonb,
  'B3 budget 0: a loop drains 2,000 note.upsert ops, one per call');
select ok((select last_seq from public.store_registers where store_id = s_c()) = 2000
          and (select count(*) from public.notes where store_id = s_c()) = 2000
          and (select count(*) from public.register_ops where store_id = s_c()) = 2000,
  'B4 ...to last_seq = 2000, every note written and logged once');

-- ===== PG: register_ping and the commands =================================
set role authenticated; select _as(u('11'));
insert into _r select 'cmd', to_jsonb(public.owner_deactivate_staff(u('13')));
reset role; select _as(u('71'));
update public.store_registers set last_contact_at = null where store_id = s_a();
insert into _r select 'ping', public.register_ping(1, 7, now() - interval '2 hours');
select ok((select (j ->> 'current')::boolean and (j ->> 'acked_seq')::bigint = (rg()).last_seq
                  and j -> 'commands' = jsonb_build_array(jsonb_build_object(
                        'id', (select j #>> '{}' from _r where k = 'cmd')::uuid, 'kind', 'staff.deactivate',
                        'user_id', u('13'), 'issued_at', now()))
             from _r where k = 'ping'),
  'PG1 register_ping: current, acked_seq and the owner''s unapplied command');
select ok((select j -> 'license' ->> 'state' = 'active' and j -> 'license' ->> 'plan' = 'pro'
                  and j -> 'license' ? 'max_staff' and j -> 'license' ? 'features' and j -> 'license' ? 'is_revoked'
                  and (j ->> 'server_now')::timestamptz = now()
                  and j ->> 'catalog' = md5(array_to_string(public.supported_permissions(), ','))
                  and j ? 'store_day' and j ? 'flags_total' and j ? 'skipped_total' and j ? 'parked_total'
             from _r where k = 'ping'),
  'PG2 ...the licence piggyback, server_now, catalog and the totals');
select ok((rg()).last_contact_at = now() and (rg()).pending_reported = 7 and (rg()).oldest_pending_at = now() - interval '2 hours',
  'PG3 ...and it stamps last_contact_at and what the PC reports');
select is((select (j ->> 'flags_total')::int from _r where k = 'ping'),
  (select count(*)::int from public.register_ops where store_id = s_a() and status = 'flagged'),
  'PG4 flags_total counts A''s flagged ops');
select one('f_after', 'note.upsert', u('13'), jsonb_build_object('id', u('a0'), 'body', 'still at the till'));
select ok(vi('f_after') = '{after_remote_deactivation}' and exists (select 1 from public.notes where id = u('a0')),
  'PG5 after_remote_deactivation: the switched-off cashier''s op before the PC applied the command (applied, flagged)');

-- ===== X: what the register login cannot do ================================
-- Every table with a store_id column, and stores, listed in owner context
-- (information_schema would hide from the client what it has no grant on).
create table _tabs as
select c.relname::text as t
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
   and (c.relname = 'stores' or exists (select 1 from pg_attribute a
                                          where a.attrelid = c.oid and a.attname = 'store_id' and not a.attisdropped));
grant select on _tabs to authenticated;
select ok((select count(*) from _tabs) >= 30
          and (select count(*) from public.customers where store_id = s_a()) > 0
          and (select count(*) from public.notes where store_id = s_a()) > 0
          and (select count(*) from public.register_ops where store_id = s_a()) > 0,
  'X0 (the probe covers every store table, and A has rows in them)');
set role authenticated; select _as(u('71'));
select throws_ok($$ select public.create_sale_order('{"total_amount":0,"discount":0,"net_amount":0,"amount_paid":0}'::jsonb,
                      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null) $$,
  '42501', null, 'X1 the register JWT calling create_sale_order is refused (42501: it is nobody''s staff)');
do $$
declare
  t   text;
  n   bigint;
  v_seen text := '';
  v_open text := '';
begin
  for t in select x.t from _tabs x loop
    begin
      execute format('select count(*) from public.%I', t) into n;
    exception when insufficient_privilege then
      n := 0;
    end;
    if n > 0 then v_seen := v_seen || t || ' '; end if;
  end loop;
  foreach t in array array['store_registers', 'register_ops', 'register_commands', 'register_bypass',
                           'register_photo_tickets', '_register_kind_perms'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      v_open := v_open || t || ' ';
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  insert into _r values ('x2', jsonb_build_object('seen', v_seen, 'open', v_open));
end $$;
reset role;
select is((select j from _r where k = 'x2'), '{"seen": "", "open": ""}'::jsonb,
  'X2 the register login reads no row of any store table, and no register table at all');
do $$
declare
  t text;
  n bigint;
  v_bad text := '';
begin
  for t in select c.table_name from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'store_id'
              and c.table_name in (select tablename from pg_tables where schemaname = 'public')
              and c.table_name <> 'audit_log' loop
    execute format('select count(*) from public.%I where store_id is null', t) into n;
    if n > 0 then v_bad := v_bad || t || ' '; end if;
  end loop;
  select count(*) into n from public.audit_log where via_register and store_id is null;
  if n > 0 then v_bad := v_bad || 'audit_log(via_register) '; end if;
  insert into _r values ('x3', to_jsonb(v_bad));
end $$;
select is((select j #>> '{}' from _r where k = 'x3'), '', 'X3 no NULL-store row anywhere after every kind of steps 1 and 2');
select ok(not exists (select 1 from public.audit_log where via_register and actor in (u('71'), u('72'), u('73')))
          and (select bool_and(exists (select 1 from public.users x where x.id = a.actor and x.store_id = a.store_id))
                 from public.audit_log a where a.via_register),
  'X4 no audit row is attributed to a register login; every via_register row names a staff member of its store');

-- ===== Q: seq conflict, revoked, replaced ==================================
select _as(u('71'));
insert into _r select 'q1', ing(jsonb_build_array(op(1, 'note.upsert', u('11'), jsonb_build_object('id', u('ab'), 'body', 'forged'))));
select ok((select not (j ->> 'current')::boolean and j ->> 'reason' = 'quarantined' and (j -> 'conflict' ->> 's')::int = 1
             from _r where k = 'q1')
          and (rg()).quarantined_at = now() and (rg()).alert = 'seq_conflict' and (rg()).conflict_seq = 1
          and not exists (select 1 from public.notes where id = u('ab')),
  'Q1 seq conflict (an applied seq with another op id): quarantined, alert seq_conflict, conflict_seq; nothing applied');
select is(public.register_ingest(1, 1, 0, null, '[]') - 'server_now',
  '{"current": false, "reason": "quarantined", "conflict": {"s": 1}}'::jsonb,
  'Q2 a quarantined register is answered current false, reason quarantined, with conflict.s');
select is(public.register_ping(1, 0, null) - 'server_now',
  '{"current": false, "reason": "quarantined", "conflict": {"s": 1}}'::jsonb,
  'Q3 ...by register_ping too');
set role authenticated; select _as(u('61'));
select public.revoke_register(s_a());
reset role; select _as(u('71'));
select is(public.register_ingest(1, 1, 0, null, '[]') - 'server_now',
  '{"current": false, "reason": "revoked"}'::jsonb, 'Q4 revoked: current false, reason revoked');
set role service_role; select _as(null);
select public._register_install(s_a(), u('72'), u('11'));
reset role;
select _as(u('71'));
select is(public.register_ingest(1, 1, 0, null, '[]') - 'server_now',
  '{"current": false, "reason": "replaced"}'::jsonb, 'Q5 the old login after a takeover: replaced');
select _as(u('72'));
select is(public.register_ingest(1, 1, 0, null, '[]') - 'server_now',
  '{"current": false, "reason": "replaced", "epoch": 2}'::jsonb, 'Q6 the new login on the old epoch: replaced, epoch 2');
select set_config('test.epoch', '2', true);
select one('q_new', 'note.upsert', u('11'), jsonb_build_object('id', u('ac'), 'body', 'after the takeover'));
select ok(st('q_new') = 'ok' and sq('q_new') = (rg()).last_seq and (rg()).epoch = 2,
  'Q7 the new register continues the store''s log (last_seq kept across claims)');
select ok(current_setting('lensy.ingest', true) = '' and current_setting('lensy.store', true) = ''
          and (select count(*) from public.register_bypass) = 0,
  'Q8 lensy.ingest empty after return');

-- ===== step 3 ==============================================================
-- Ids of this part: v3('xx'). A is on r2 (u('72')), epoch 2.
create function v3(p text) returns uuid language sql immutable as $$
  select ('34000000-0000-4000-8000-0000000003' || p)::uuid $$;
create function usr(p uuid) returns public.users language sql stable as $$
  select * from public.users where id = p $$;
-- A refusal with exactly that code, and the alert set; the alert is then
-- cleared so the next refusal shows its own.
create function refd(p_key text, p_code text) returns boolean language plpgsql as $$
declare
  v boolean;
begin
  v := st(p_key) = 'refused' and vi(p_key) = array[p_code] and (rg()).alert = 'refused';
  update public.store_registers set alert = null, alert_at = null where store_id = s_a();
  return coalesce(v, false);
end $$;
update public.store_registers set alert = null, alert_at = null where store_id = s_a();

-- ===== V3: shape of step 3 =================================================
select is((select coalesce(string_agg(f || '/' || r, ','), '')
             from unnest(array['public._ingest_protected(uuid, uuid)', 'public._ingest_admin_role(uuid)',
                               'public._ingest_seats_full(uuid)', 'public._ingest_code(jsonb)',
                               'public._register_undo_capture()', 'public._register_undo_keep(text, text)',
                               'public._register_export_cols()', 'public._register_export_store()']) f,
                  unnest(array['anon', 'authenticated', 'service_role']) r
            where has_function_privilege(r, f, 'execute')),
  '', 'V12 step 3''s internals are closed to every client role');
select is((select coalesce(string_agg(f, ','), '')
             from unnest(array['public.register_revert_ops(uuid, bigint, text)', 'public.register_export(text, text, integer)',
                               'public.register_export_heads()', 'public.register_snapshot_done()',
                               'public.register_export_ops(bigint, integer)',
                               'public.register_fill_gap(uuid, bigint, bigint, text)',
                               'public.prune_register_ops(timestamptz)']) f
            where not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  '', 'V13 revert, exports, export_ops, fill_gap and prune: authenticated (each checks its caller), never anon');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
             where oid in ('public.register_undo'::regclass, 'public.register_ops_foreign'::regclass))
          and not has_table_privilege('authenticated', 'public.register_undo', 'select')
          and not has_table_privilege('authenticated', 'public.register_ops_foreign', 'select')
          and (select count(*) from pg_trigger where tgname = 'zz_register_undo' and not tgisinternal) = 25
          and (select count(*) from pg_trigger where tgname = 'zz_register_only' and not tgisinternal) = 25
          and not exists (select 1 from pg_trigger g where g.tgname = 'zz_register_only'
                             and not exists (select 1 from pg_trigger h where h.tgname = 'zz_register_undo'
                                                and h.tgrelid = g.tgrelid)),
  'V14 register_undo and register_ops_foreign: RLS forced, no client privilege; zz_register_undo on exactly the guard''s 25 tables');

-- ===== ST: staff and RBAC, an ok test for each kind ========================
select one('st_create', 'staff.create', u('11'), jsonb_build_object('id', v3('01'), 'username', 'nour_a34',
  'full_name', 'Nour', 'role_id', u('a2'), 'is_active', true));
select ok(st('st_create') = 'ok'
          and (select password_hash = 'register-local' and username = 'nour_a34' and full_name = 'Nour' and role_id = u('a2')
                      and is_active and created_at = now() and store_id = s_a() from public.users where id = v3('01')),
  'ST1 staff.create ok: a register-local user with the PC''s id, created at t');
select one('st_prof', 'staff.update_profile', u('11'), jsonb_build_object('user_id', v3('01'), 'full_name', 'Nour M'));
select ok(st('st_prof') = 'ok' and (usr(v3('01'))).full_name = 'Nour M' and (usr(v3('01'))).role_id = u('a2')
          and (usr(v3('01'))).is_active,
  'ST2 staff.update_profile ok: the name changes, nothing else');
select one('st_acc', 'staff.set_access', u('11'), jsonb_build_object('user_id', v3('01'), 'role_id', w('a3'), 'active', true));
select ok(st('st_acc') = 'ok' and (usr(v3('01'))).role_id = w('a3') and (usr(v3('01'))).is_active,
  'ST3 staff.set_access ok: another position');
select one('st_role', 'role.create', u('11'), jsonb_build_object('id', v3('02'), 'name', ' Optician34 '));
select ok(st('st_role') = 'ok'
          and (select name = 'Optician34' and created_at = now() and store_id = s_a() from public.roles where id = v3('02')),
  'ST4 role.create ok: the name trimmed (029), created at t');
select one('st_rp', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('02'), 'code', 'lab.edit',
  'granted', true, 'id', v3('03')));
select ok(st('st_rp') = 'ok'
          and exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
                       where rp.id = v3('03') and rp.role_id = v3('02') and p.code = 'lab.edit'),
  'ST5 role.set_permission ok: the grant row, with the PC''s id');
select one('st_rp_off', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('02'), 'code', 'lab.edit', 'granted', false));
select ok(st('st_rp_off') = 'ok' and not exists (select 1 from public.role_permissions where role_id = v3('02')),
  'ST6 ...and granted false removes it');
select one('st_up', 'user.set_permission', u('11'), jsonb_build_object('user_id', v3('01'), 'code', 'history.refund', 'allow', true));
select one('st_up_no', 'user.set_permission', u('11'), jsonb_build_object('user_id', v3('01'), 'code', 'history.void', 'allow', false));
select one('st_up_rm', 'user.set_permission', u('11'), jsonb_build_object('user_id', v3('01'), 'code', 'history.void', 'allow', null));
select ok(st('st_up') = 'ok' and st('st_up_no') = 'ok' and st('st_up_rm') = 'ok'
          and (select array_agg(p.code || '=' || up.allow) from public.user_permissions up
                 join public.permissions p on p.id = up.permission_id where up.user_id = v3('01')) = '{history.refund=true}',
  'ST7 user.set_permission ok: allow true or false, and null removes the exception');
select one('st_cmd', 'staff.set_access', u('11'), jsonb_build_object('user_id', u('13'), 'active', false,
  'via_command', (select j #>> '{}' from _r where k = 'cmd')), now(), null, '{"sid": null}');
select ok(st('st_cmd') = 'ok' and not (usr(u('13'))).is_active and (usr(u('13'))).role_id = u('a2')
          and (select applied_seq from public.register_commands
                where id = (select (j #>> '{}')::uuid from _r where k = 'cmd')) = sq('st_cmd')
          and (select j -> 'commands' from _r where k = 'st_cmd') = '[]'::jsonb,
  'ST8 staff.set_access via_command (no sid, the owner as actor): the cashier off, applied_seq = its seq, the command no longer sent');
select one('st_react', 'staff.set_access', u('11'), jsonb_build_object('user_id', u('13'), 'role_id', u('a2'), 'active', true));
select ok(vi('st_react') = '{reactivated_after_remote_deactivation}' and (usr(u('13'))).is_active,
  'ST9 reactivated_after_remote_deactivation: the cashier the phone switched off is switched on again (applied)');

-- A manager (staff.view/edit/create, not staff.delete, not an admin), made by ops.
select one('m3_role', 'role.create', u('11'), jsonb_build_object('id', v3('10'), 'name', 'Manager34'));
select one('m3_g1', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('10'), 'code', 'staff.view', 'granted', true));
select one('m3_g2', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('10'), 'code', 'staff.edit', 'granted', true));
select one('m3_g3', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('10'), 'code', 'staff.create', 'granted', true));
select one('m3_usr', 'staff.create', u('11'), jsonb_build_object('id', v3('11'), 'username', 'manager_a34', 'role_id', v3('10')));
select one('m3_sess', 'session.start', v3('11'), jsonb_build_object('sid', v3('12'), 'user_id', v3('11')), now(), v3('12'));
create function mg(p_key text, p_k text, p_p jsonb) returns jsonb language sql as $$
  select one(p_key, p_k, v3('11'), p_p, now(), v3('12')) $$;
select ok(st('m3_role') = 'ok' and st('m3_g1') = 'ok' and st('m3_g2') = 'ok' and st('m3_g3') = 'ok'
          and st('m3_usr') = 'ok' and st('m3_sess') = 'ok'
          and public._resolve_can_for('staff.create', v3('11'), s_a())
          and not public._resolve_can_for('staff.delete', v3('11'), s_a())
          and not public._is_store_admin_for(v3('11'), s_a()),
  'ST10 (fixtures by ops: a manager with staff.view/edit/create, no staff.delete, not an admin, and his session)');

-- ===== F3: each staff flag once, alone =====================================
select mg('f3_admin', 'staff.create', jsonb_build_object('id', v3('13'), 'username', 'admin2_a34', 'role_id', u('a1')));
select ok(vi('f3_admin') = '{assign_admin}' and (usr(v3('13'))).role_id = u('a1'),
  'F3a assign_admin: a manager who is not an admin creates an Admin (applied)');
select mg('f3_self', 'staff.set_access', jsonb_build_object('user_id', v3('11'), 'role_id', v3('10'), 'active', true));
select is(vi('f3_self'), '{self_change}', 'F3b self_change: the manager changes his own access');
select mg('f3_del', 'staff.set_access', jsonb_build_object('user_id', v3('01'), 'role_id', w('a3'), 'active', false));
select ok(vi('f3_del') = '{perm:staff.delete}' and not (usr(v3('01'))).is_active,
  'F3c perm:staff.delete: switching someone off without staff.delete (029:180; applied)');
select mg('f3_uself', 'user.set_permission', jsonb_build_object('user_id', v3('11'), 'code', 'reports.view', 'allow', true));
select is(vi('f3_uself'), '{self_change}', 'F3d self_change: a permission exception for oneself');
select mg('f3_rself', 'role.set_permission', jsonb_build_object('role_id', v3('10'), 'code', 'staff.edit', 'granted', false));
select ok(vi('f3_rself') = '{self_change}' and not public._resolve_can_for('staff.edit', v3('11'), s_a()),
  'F3e self_change: taking staff.edit off one''s own position (029:135-138; applied)');
update public.store_licenses set max_staff = (select count(*) from public.users where store_id = s_a() and is_active)
 where store_id = s_a();
select one('f3_max', 'staff.create', u('11'), jsonb_build_object('id', v3('14'), 'username', 'extra_a34', 'role_id', u('a2')));
select one('f3_max2', 'staff.set_access', u('11'), jsonb_build_object('user_id', v3('01'), 'role_id', w('a3'), 'active', true));
update public.store_licenses set max_staff = null where store_id = s_a();
select ok(vi('f3_max') = '{max_staff}' and vi('f3_max2') = '{max_staff}'
          and (usr(v3('14'))).is_active and (usr(v3('01'))).is_active,
  'F3f max_staff: an active user created, or one switched on, at the licence''s limit (031; applied)');
select one('f3_tm1', 'staff.set_access', u('11'), jsonb_build_object('user_id', v3('f0'), 'active', true));
select one('f3_tm2', 'staff.update_profile', u('11'), jsonb_build_object('user_id', v3('f0'), 'full_name', 'x'));
select one('f3_tm3', 'role.set_permission', u('11'), jsonb_build_object('role_id', v3('f1'), 'code', 'pos.view', 'granted', true));
select one('f3_tm4', 'user.set_permission', u('11'), jsonb_build_object('user_id', v3('f0'), 'code', 'pos.view', 'allow', true));
select ok(vi('f3_tm1') = '{target_missing}' and vi('f3_tm2') = '{target_missing}'
          and vi('f3_tm3') = '{target_missing}' and vi('f3_tm4') = '{target_missing}',
  'F3g target_missing: staff.set_access, staff.update_profile, role.set_permission, user.set_permission (design 3.6)');

-- ===== R3: refusals; the target unchanged, the alert set ===================
insert into public.inventory (id, name, sale_price, store_id) values (v3('b1'), 'Frame B34', 50, s_b());
select one('r3_owner', 'staff.set_access', u('11'), jsonb_build_object('user_id', u('11'), 'role_id', u('a2'), 'active', false));
select ok(refd('r3_owner', 'protected_target') and (usr(u('11'))).role_id = u('a1') and (usr(u('11'))).is_active,
  'R3a protected_target: a forged staff.set_access on the owner; his row unchanged, alert set');
select one('r3_reg', 'staff.create', u('11'), jsonb_build_object('id', u('72'), 'username', 'reg_a34', 'role_id', u('a1')));
select ok(refd('r3_reg', 'protected_target') and not exists (select 1 from public.users where id = u('72')),
  'R3b protected_target: staff.create with the register''s own uid; no staff row, alert set');
select one('r3_prod', 'product.upsert', u('11'), jsonb_build_object('id', v3('b1'), 'name', 'Stolen frame', 'sale_price', 1));
select ok(refd('r3_prod', 'foreign_id')
          and (select name = 'Frame B34' and sale_price = 50 and store_id = s_b() from public.inventory where id = v3('b1')),
  'R3c foreign_id: another store''s product id; that row unchanged, alert set');
select one('r3_actor', 'staff.set_access', u('21'), jsonb_build_object('user_id', u('14'), 'active', false), now(), u('5a'));
select ok(refd('r3_actor', 'foreign_actor') and (usr(u('14'))).is_active,
  'R3d foreign_actor: another store''s admin as the actor; the clerk unchanged, alert set');
select one('r3_role', 'role.create', u('11'), jsonb_build_object('id', v3('15'), 'name', ' admin '));
select ok(refd('r3_role', 'reserved_role') and not exists (select 1 from public.roles where id = v3('15')),
  'R3e reserved_role: a position named '' admin ''; nothing created, alert set');
select one('r3_grant', 'role.set_permission', u('11'), jsonb_build_object('role_id', u('a1'), 'code', 'pos.view', 'granted', true));
select ok(refd('r3_grant', 'reserved_role') and not exists (select 1 from public.role_permissions where role_id = u('a1')),
  'R3f reserved_role: a grant on the Admin position; none written, alert set');
select one('r3_cmd', 'staff.set_access', u('11'), jsonb_build_object('user_id', u('14'), 'active', false,
  'via_command', gen_random_uuid()), now(), null, '{"sid": null}');
select ok(refd('r3_cmd', 'bad_command') and (usr(u('14'))).is_active,
  'R3g bad_command: a via_command that names no open command; the clerk unchanged, alert set');
select one('r3_name', 'staff.create', u('11'), jsonb_build_object('id', v3('16'), 'username', 'SuperAdmin'));
select ok(refd('r3_name', 'reserved_name') and not exists (select 1 from public.users where id = v3('16')),
  'R3h reserved_name: a cashier called SuperAdmin; nothing created, alert set');
select one('r3_cloud', 'user.set_permission', u('11'), jsonb_build_object('user_id', u('11'), 'code', 'pos.view', 'allow', false));
select ok(refd('r3_cloud', 'protected_target') and not exists (select 1 from public.user_permissions where user_id = u('11')),
  'R3i protected_target: user.set_permission on a cloud login (the owner); nothing written, alert set');

-- an INT hold: the 033 per-store username index
select one('h3_dup', 'staff.create', u('11'), jsonb_build_object('id', v3('17'), 'username', 'NOUR_A34'));
select ok(hc('h3_dup') = 'INT' and (rg()).held_error ->> 'constraint' = 'users_store_username_key'
          and not exists (select 1 from public.users where id = v3('17')),
  'H3a INT: staff.create of a name another user of the store has under lower(btrim()) (033''s index)');
select one('h3_fix', 'staff.create', u('11'), jsonb_build_object('id', v3('17'), 'username', 'nour2_a34'));
select ok(st('h3_fix') = 'ok' and (rg()).held_seq is null, 'H3b ...a renamed resend applies and clears the hold');

-- ===== LC: the licence ends in the middle of a batch =======================
update public.store_licenses set expires_at = now() - interval '1 minute' where store_id = s_a();
insert into _r select 'lic_mid', ing(jsonb_build_array(
  op(nx(),     'note.upsert', u('11'), jsonb_build_object('id', v3('20'), 'body', 'before the end'), now() - interval '2 minutes'),
  op(nx() + 1, 'note.upsert', u('11'), jsonb_build_object('id', v3('21'), 'body', 'after the end'))));
update public.store_licenses set expires_at = null where store_id = s_a();
select ok((select (j ->> 'current')::boolean and j -> 'held' = 'null'::jsonb and (j ->> 'acked_seq')::bigint = (rg()).last_seq
                  and j -> 'results' = jsonb_build_array(jsonb_build_object('s', (rg()).last_seq, 'st', 'flagged',
                                                                            'v', '["licence"]'::jsonb))
             from _r where k = 'lic_mid')
          and exists (select 1 from public.notes where id = v3('20'))
          and exists (select 1 from public.notes where id = v3('21')),
  'LC1 the licence ends between two ops of one batch: never refused; both applied, the later one flagged licence');

-- ===== U: the undo log =====================================================
select ok((select count(*) = 1 and bool_and(action = 'insert' and table_name = 'users'
                                            and pk = jsonb_build_object('id', v3('01')) and before_row is null)
             from public.register_undo where store_id = s_a() and seq = sq('st_create'))
          and (select count(*) = 1 and bool_and(action = 'update' and before_row ->> 'full_name' = 'Nour')
                 from public.register_undo where store_id = s_a() and seq = sq('st_prof'))
          and (select count(*) = 1 and bool_and(action = 'delete' and table_name = 'role_permissions'
                                                and before_row ->> 'id' = v3('03')::text)
                 from public.register_undo where store_id = s_a() and seq = sq('st_rp_off'))
          and not exists (select 1 from public.register_undo
                           where store_id = s_a() and seq in (sq('k_sess'), sq('m3_sess'), sq('r3_owner'))) -- (h3_dup's seq is h3_fix's)
          and not exists (select 1 from public.register_undo where table_name = 'roles' and pk ->> 'id' = w('a3')::text)
          and not exists (select 1 from public.register_undo where store_id = s_b()),
  'U1 the undo log: a row per changed row keyed by the op''s seq (insert: its key; update/delete: the row before); none for log kinds, refused or held ops, admin-token writes or an ordinary store');
select ok((select count(*) from public.register_undo where store_id = s_c()) = 2000
          and (select count(distinct seq) from public.register_undo where store_id = s_c()) = 2000,
  'U2 ...one row for each of the 2,000 drained notes of C');

-- ===== RV: a forgery after a token theft, and its revert (design 6.3) =====
set role authenticated; select _as(u('11'));
insert into _r select 'cmd2', to_jsonb(public.owner_deactivate_staff(u('14')));
reset role; select _as(u('72'));
create function snap(p uuid) returns jsonb language plpgsql as $$
declare
  t   text;
  v_x jsonb;
  v   jsonb := '{}';
begin
  foreach t in array array['customers', 'inventory', 'stock_movements', 'sales', 'sale_items', 'order_examinations',
                           'sale_payments', 'shift_closes', 'invoice_counter', 'suppliers', 'purchases', 'purchase_items',
                           'purchase_payments', 'notes', 'settings', 'lens_types', 'frame_colors', 'frame_types',
                           'prescriptions', 'warehouses', 'users', 'roles'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), ''[]'') from public.%I x where x.store_id = $1', t)
      into v_x using p;
    v := v || jsonb_build_object(t, v_x);
  end loop;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into v_x
    from public.role_permissions x where public.role_store(x.role_id) = p;
  v := v || jsonb_build_object('role_permissions', v_x);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') into v_x
    from public.user_permissions x where public.user_store(x.user_id) = p;
  v := v || jsonb_build_object('user_permissions', v_x);
  select to_jsonb(x) into v_x from public.stores x where x.id = p;
  return v || jsonb_build_object('stores', v_x);
end $$;
create table _snap (k text primary key, j jsonb);
grant all on _snap to authenticated;
create function lq() returns bigint language sql stable as $$ select (j #>> '{}')::bigint from _snap where k = 'last' $$;
insert into _snap values ('before', snap(s_a())), ('last', to_jsonb((rg()).last_seq));
-- the thief, with the register's token, sends three ops first
insert into _r select 'rv_forge_ops', jsonb_build_array(
  op(lq() + 1, 'customer.upsert', u('11'), jsonb_build_object('id', v3('30'), 'name', 'Forged customer')),
  op(lq() + 2, 'sale.create', u('11'), sc(v3('31'), '349001', jsonb_build_array(li(v3('32'), w('03'), 1, 300, 0, v3('33'))),
                                         jsonb_build_array(pa(v3('34'), 'cash', 300)), 300,
                                         jsonb_build_object('customer_id', v3('30')))),
  op(lq() + 3, 'staff.set_access', u('11'), jsonb_build_object('user_id', u('14'), 'active', false,
                                                              'via_command', (select j #>> '{}' from _r where k = 'cmd2')))
    || '{"sid": null}');
insert into _r select 'rv_forge', ing((select j from _r where k = 'rv_forge_ops'));
select ok((rg()).last_seq = lq() + 3 and (select j -> 'results' from _r where k = 'rv_forge') = '[]'::jsonb
          and exists (select 1 from public.customers where id = v3('30'))
          and (sal(v3('31'))).amount_paid = 300 and not (usr(u('14'))).is_active
          and (select next_val from public.invoice_counter where store_id = s_a() and prefix = '') = 349002,
  'RV1 (the three forged ops apply: a customer, a sale with a payment and a stock movement, the clerk switched off)');
select ok((select array_agg(distinct table_name || ':' || action) from public.register_undo
            where store_id = s_a() and seq = lq() + 2)
          @> array['sales:insert', 'sales:update', 'sale_items:insert', 'stock_movements:insert', 'inventory:update',
                   'sale_payments:insert', 'invoice_counter:update'],
  'U3 the forged sale''s undo rows include the cascades: amount_paid (sales update), stock_qty (inventory update), invoice_counter');
-- the genuine PC sends its own ops at those seqs: a seq conflict
insert into _r select 'rv_genuine', jsonb_build_array(
  op(lq() + 1, 'note.upsert', u('11'), jsonb_build_object('id', v3('40'), 'body', 'genuine')),
  op(lq() + 2, 'customer.upsert', u('11'), jsonb_build_object('id', v3('41'), 'name', 'Genuine customer')));
insert into _r select 'rv_conflict', ing((select j from _r where k = 'rv_genuine'));
select ok((select j ->> 'reason' = 'quarantined' and (j -> 'conflict' ->> 's')::bigint = lq() + 1 from _r where k = 'rv_conflict')
          and (rg()).quarantined_at is not null and (rg()).conflict_seq = lq() + 1,
  'RV2 (the genuine PC''s next op collides: quarantined at the first forged seq)');
set role authenticated; select _as(u('11'));
select throws_ok(format('select public.register_revert_ops(%L, %s, %L)', s_a(), lq() + 1, 'owner tries'),
  '42501', null, 'RV3 register_revert_ops: refused for a non-platform caller (the owner)');
select _as(u('61'));
select throws_ok(format('select public.register_revert_ops(%L, 1, %L)', s_c(), 'not stolen'),
  '55000', null, 'RV4 ...and for a store whose register is neither quarantined nor revoked');
insert into _r select 'rv', public.register_revert_ops(s_a(), lq() + 1, 'stolen register token');
reset role;
select is(snap(s_a()), (select j from _snap where k = 'before'),
  'RV5 every guarded table of A equals its snapshot before the forgery (stock_qty, amount_paid, invoice_counter, the clerk''s access)');
select ok((rg()).last_seq = lq()
          and not exists (select 1 from public.register_ops where store_id = s_a() and seq > lq())
          and (select count(*) = 3 and bool_and(status = 'reverted' and original_status = 'ok' and reverted_by = u('61'))
                      and array_agg(op_id order by seq) = (select array_agg((e ->> 'i')::uuid order by (e ->> 's')::int)
                                                             from _r, jsonb_array_elements(_r.j) e where _r.k = 'rv_forge_ops')
                 from public.register_ops_foreign where store_id = s_a())
          and not exists (select 1 from public.register_undo where store_id = s_a() and seq > lq())
          and (select applied_seq from public.register_commands
                where id = (select (j #>> '{}')::uuid from _r where k = 'cmd2')) is null,
  'RV6 the forged ops sit in register_ops_foreign (status reverted, their op ids), last_seq is back, their undo rows are spent, the command is open again');
select ok((rg()).max_t = (select max(least(o.occurred_at, o.received_at + interval '10 minutes')) from public.register_ops o
                           where o.store_id = s_a() and o.status in ('ok', 'flagged', 'skipped'))
          and (rg()).quarantined_at is not null
          and exists (select 1 from public.audit_log where table_name = 'register_ops' and action = 'revert'
                         and row_id = (lq() + 1)::text and actor = u('61') and store_id = s_a())
          and (select (j ->> 'ops')::int = 3 from _r where k = 'rv'),
  'RV7 max_t recomputed from the ops left; still quarantined until the owner re-claims; audited');
-- the owner re-claims on the genuine PC (create-register reclaim, design 6.3)
insert into auth.users (id, email) values (v3('74'), 'register.a.3@t34');
set role service_role; select _as(null);
select public._register_install(s_a(), v3('74'), u('11'));
reset role;
select set_config('test.epoch', '3', true);
select _as(v3('74'));
insert into _r select 'rv_apply', ing((select j from _r where k = 'rv_genuine'));
-- (both are applied; clock_back only, because the revert recomputes max_t
-- from the log, where F17's op at now() + 1 hour still counts, while F17's
-- manual reset of max_t to now() is not in the log)
select ok((select (j ->> 'current')::boolean and (j ->> 'acked_seq')::bigint = lq() + 2
                  and (select bool_and(e ->> 'st' = 'flagged' and e -> 'v' = '["clock_back"]'::jsonb)
                         from jsonb_array_elements(j -> 'results') e)
             from _r where k = 'rv_apply')
          and (select count(*) from public.register_ops where store_id = s_a() and seq in (lq() + 1, lq() + 2)
                  and status in ('ok', 'flagged')) = 2
          and exists (select 1 from public.notes where id = v3('40'))
          and exists (select 1 from public.customers where id = v3('41'))
          and not exists (select 1 from public.customers where id = v3('30')),
  'RV8 after the re-claim the genuine ops at the same seqs apply');

-- ===== FG: register_fill_gap ===============================================
set role authenticated; select _as(u('11'));
select throws_ok(format('select public.register_fill_gap(%L, %s, %s, %L)', s_a(), lq() + 3, lq() + 4, 'lost disk'),
  '42501', null, 'FG1 register_fill_gap: platform admins only');
select _as(u('61'));
select throws_ok(format('select public.register_fill_gap(%L, %s, %s, %L)', s_a(), lq() + 4, lq() + 5, 'lost disk'),
  '55000', null, 'FG2 ...and only from the next seq');
insert into _r select 'fg', public.register_fill_gap(s_a(), lq() + 3, lq() + 4, 'lost with the old disk');
reset role;
select ok((select count(*) = 2 and bool_and(status = 'lost' and kind = 'noop' and op_id is null and payload is null
                                            and detail ->> 'reason' = 'lost with the old disk')
             from public.register_ops where store_id = s_a() and seq between lq() + 3 and lq() + 4)
          and (rg()).last_seq = lq() + 4
          and exists (select 1 from public.audit_log where table_name = 'register_ops' and action = 'fill_gap'
                         and store_id = s_a() and actor = u('61')),
  'FG3 lost noop rows fill the gap; last_seq moves past it; audited');

-- ===== EO: register_export_ops (the owner's session only) ==================
set role authenticated; select _as(u('11'));
insert into _r select 'eo', (select jsonb_agg(jsonb_build_array(x.seq, x.status = 'lost', x.kind) order by x.seq)
                               from public.register_export_ops(lq() + 1, 500) x);
select _as(u('31'));
insert into _r select 'eo_c', (select jsonb_build_array(count(*), min(x.seq), max(x.seq))
                                 from public.register_export_ops(1, 9999) x);
select _as(v3('74'));
select throws_ok('select * from public.register_export_ops(1, 10)', '42501', null,
  'EO1 register_export_ops: never the register login');
select _as(u('21'));
select throws_ok('select * from public.register_export_ops(1, 10)', '42501', null,
  'EO2 ...nor a staff login that owns no store');
reset role;
select is((select j from _r where k = 'eo'),
  jsonb_build_array(jsonb_build_array(lq() + 1, false, 'note.upsert'), jsonb_build_array(lq() + 2, false, 'customer.upsert'),
                    jsonb_build_array(lq() + 3, true, 'noop'), jsonb_build_array(lq() + 4, true, 'noop')),
  'EO3 the owner reads his store''s log: contiguous rows from from_seq, lost rows included');
select is((select j from _r where k = 'eo_c'), '[500, 1, 500]'::jsonb,
  'EO4 ...another owner reads his own store''s, at most 500 rows a call');

-- ===== EX: the setup exports (the register login, its window only) ========
create function exa(p_table text) returns jsonb language sql as $$
  select public.register_export(p_table, null, 1000) -> 'rows' $$;
grant execute on function exa(text) to authenticated;
set role authenticated; select _as(v3('74'));
insert into _r select 'ex_a', jsonb_build_object(
  'users', exa('users'), 'notes', exa('notes'), 'sale_payments', exa('sale_payments'), 'shift_closes', exa('shift_closes'),
  'invoice_counter', exa('invoice_counter'), 'role_permissions', exa('role_permissions'),
  'user_permissions', exa('user_permissions'), 'stores', exa('stores'), 'store_licenses', exa('store_licenses'),
  'heads', (select jsonb_object_agg(h.table_name, h.row_count) from public.register_export_heads() h));
select throws_ok($$ select public.register_export('audit_log') $$, '22023', null,
  'EX1 a table outside the whitelist is refused');
select _as(u('73'));
insert into _r select 'ex1', public.register_export('notes', null, 5000);
insert into _r select 'ex2', public.register_export('notes', (select j ->> 'after' from _r where k = 'ex1'), 1000);
insert into _r select 'ex3', public.register_export('notes', (select j ->> 'after' from _r where k = 'ex2'), 1000);
select _as(u('31'));
select throws_ok($$ select public.register_export('notes') $$, '42501', null, 'EX2 a staff login (the owner) cannot export');
select _as(u('73'));
select public.register_snapshot_done();
select throws_ok($$ select public.register_export('notes') $$, '42501', null,
  'EX3 after register_snapshot_done the window is closed');
reset role;
update public.store_registers set snapshot_until = now() - interval '1 second' where store_id = s_a();
set role authenticated; select _as(v3('74'));
select throws_ok($$ select public.register_export_heads() $$, '42501', null, 'EX4 ...and once snapshot_until has passed');
reset role;
select ok((select jsonb_array_length(j -> 'rows') = 1000 and (j ->> 'more')::boolean from _r where k = 'ex1')
          and (select jsonb_array_length(j -> 'rows') = 1000 and (j ->> 'more')::boolean from _r where k = 'ex2')
          and (select jsonb_array_length(j -> 'rows') = 0 and not (j ->> 'more')::boolean and j -> 'after' = 'null'::jsonb
                 from _r where k = 'ex3')
          and (select count(distinct e ->> 'id') from _r, jsonb_array_elements(_r.j -> 'rows') e where _r.k in ('ex1', 'ex2')) = 2000,
  'EX5 keyset pages of at most 1,000 rows: C''s 2,000 notes in two pages, then an empty last page');
select ok((select bool_and(not (e ? 'password_hash') and e ? 'protected')
             from _r, jsonb_array_elements(_r.j -> 'users') e where _r.k = 'ex_a')
          and (select bool_and((e ->> 'protected')::boolean = (e ->> 'id' = u('11')::text))
                 from _r, jsonb_array_elements(_r.j -> 'users') e where _r.k = 'ex_a')
          and (select jsonb_array_length(j -> 'users') from _r where k = 'ex_a')
              = (select count(*) from public.users where store_id = s_a()),
  'EX6 users: every staff row of the store, no password_hash, protected true only for the owner (cloud login)');
select ok((select bool_or(e ->> 'id' = u('c4')::text and e ->> 'user_id' = u('11')::text)
             from _r, jsonb_array_elements(_r.j -> 'notes') e where _r.k = 'ex_a')
          and (select jsonb_array_length(j -> 'sale_payments') from _r where k = 'ex_a')
              = (select count(*) from public.sale_payments where store_id = s_a())
          and (select jsonb_array_length(j -> 'shift_closes') from _r where k = 'ex_a')
              = (select count(*) from public.shift_closes where store_id = s_a())
          and (select j -> 'invoice_counter' -> 0 ->> 'next_val' from _r where k = 'ex_a')
              = (select next_val::text from public.invoice_counter where store_id = s_a() and prefix = '')
          and (select jsonb_array_length(j -> 'role_permissions') from _r where k = 'ex_a')
              = (select count(*) from public.role_permissions x join public.roles r on r.id = x.role_id where r.store_id = s_a())
          and (select jsonb_array_length(j -> 'user_permissions') from _r where k = 'ex_a')
              = (select count(*) from public.user_permissions x join public.users r on r.id = x.user_id where r.store_id = s_a())
          and (select j -> 'stores' -> 0 ->> 'id' = s_a()::text and jsonb_array_length(j -> 'stores') = 1 from _r where k = 'ex_a')
          and (select jsonb_array_length(j -> 'store_licenses') = 1 and not (j -> 'store_licenses' -> 0 ? 'license_key')
                 from _r where k = 'ex_a'),
  'EX7 the whitelist: private notes, sale_payments, shift_closes, invoice_counter, the store''s role/user permissions, the store and licence rows (no licence key)');
select ok((select (j -> 'heads' ->> 'notes')::bigint = (select count(*) from public.notes where store_id = s_a())
                  and (j -> 'heads' ->> 'permissions')::bigint = (select count(*) from public.permissions)
                  and (select count(*) from jsonb_object_keys(j -> 'heads')) = 25
             from _r where k = 'ex_a'),
  'EX8 register_export_heads: a row count for each of the 25 exported tables');

-- ===== RD: reverting updates and deletes of existing rows (a revoked register)
-- A genuine sale with a lab order; then forged: its lab status, its void
-- (refund row + restock), a note.delete and a customer.delete.
select _as(v3('74'));
select one('rd_sale', 'sale.create', u('11'), sc(v3('50'), '349100', jsonb_build_array(li(v3('51'), w('03'), 1, 300, 0, v3('52'))),
  jsonb_build_array(pa(v3('53'), 'cash', 300)), 300, '{"lab_status": "Not Started"}'));
insert into _snap values ('rd_before', snap(s_a())), ('rd_last', to_jsonb((rg()).last_seq));
insert into _r select 'rd_forge', ing(jsonb_build_array(
  op(nx(),     'sale.lab_status', u('11'), jsonb_build_object('sale_id', v3('50'), 'status', 'Ready')),
  op(nx() + 1, 'sale.void',       u('11'), jsonb_build_object('sale_id', v3('50'), 'reason', 'forged',
                                    'refunds', jsonb_build_array(pa(v3('54'), 'cash', -300)),
                                    'restock', jsonb_build_array(jsonb_build_object('id', v3('55'), 'product_id', w('03'), 'qty', 1)))),
  op(nx() + 2, 'note.delete',     u('11'), jsonb_build_object('id', v3('20'))),
  op(nx() + 3, 'customer.delete', u('11'), jsonb_build_object('id', v3('41')))));
select ok(st('rd_sale') in ('ok', 'flagged') and (sal(v3('50'))).voided_at is not null and (sal(v3('50'))).amount_paid = 0
          and (sal(v3('50'))).lab_ready_at is not null
          and not exists (select 1 from public.notes where id = v3('20'))
          and not exists (select 1 from public.customers where id = v3('41'))
          and (rg()).last_seq = (select (j #>> '{}')::bigint from _snap where k = 'rd_last') + 4,
  'RD1 (the forged lab status, void, note.delete and customer.delete apply)');
set role authenticated; select _as(u('61'));
select public.revoke_register(s_a());
insert into _r select 'rd', public.register_revert_ops(s_a(), (select (j #>> '{}')::bigint + 1 from _snap where k = 'rd_last'),
                                                       'forged void');
reset role;
select is(snap(s_a()), (select j from _snap where k = 'rd_before'),
  'RD2 a revoked register''s forged updates and deletes revert: the sale live again with amount_paid back from its ledger, its lab times, the restocked units, the deleted rows re-inserted');

-- ===== PR: retention ========================================================
update public.register_ops set received_at = now() - interval '401 days' where store_id = s_c() and seq <= 100;
update public.register_ops set received_at = now() - interval '61 days' where store_id = s_a() and seq <= 50;
create table _pr as
select (select count(*) from public.register_undo where store_id = s_a() and seq <= 50) as a50,
       (select count(*) from public.register_undo where store_id = s_a() and seq > 50) as a_rest,
       (select count(*) from public.register_undo where store_id = s_c()) as c_undo,
       (select count(*) from public.register_ops where store_id = s_c()) as c_ops;
set role authenticated; select _as(u('11'));
select throws_ok($$ select public.prune_register_ops(now()) $$, '42501', null, 'PR1 prune_register_ops: platform admins only');
select _as(u('61'));
insert into _r select 'pr', public.prune_register_ops(now());
reset role;
select ok((select count(*) from public.register_ops where store_id = s_c()) = (select c_ops from _pr)
          and (select bool_and(payload is null and op_id is not null and kind = 'note.upsert' and status = 'flagged'
                               and occurred_at is not null) and count(*) = 100
                 from public.register_ops where store_id = s_c() and seq <= 100)
          and not exists (select 1 from public.register_ops where store_id = s_c() and seq > 100 and payload is null)
          and not exists (select 1 from public.register_ops where store_id = s_a() and payload is null
                             and status not in ('dup_import', 'lost', 'parked'))
          and (select payload_pruned_seq from public.store_registers where store_id = s_c()) = 100,
  'PR2 payloads received more than 400 days ago are dropped, the row skeleton kept; newer payloads (and A''s 61-day-old ones) kept');
select ok((select a50 > 0 from _pr)
          and not exists (select 1 from public.register_undo where store_id = s_a() and seq <= 50)
          and (select count(*) from public.register_undo where store_id = s_a() and seq > 50) = (select a_rest from _pr)
          and (select undo_pruned_seq from public.store_registers where store_id = s_a()) = 50
          and (select count(*) from public.register_undo where store_id = s_c()) = (select c_undo - 100 from _pr),
  'PR3 undo rows go 60 days after INGEST (received_at); later ones stay');
set role authenticated; select _as(u('31'));
select throws_like($$ select * from public.register_export_ops(1, 10) $$, 'retention%',
  'PR4 register_export_ops reaching a pruned payload: retention');
select is((select count(*)::int from public.register_export_ops(101, 10)), 10, 'PR5 ...from the first kept seq it pages on');
select _as(u('61'));
select public.revoke_register(s_a());
select throws_like(format('select public.register_revert_ops(%L, 40, %L)', s_a(), 'too old'), 'undo_pruned%',
  'PR6 a revert reaching a pruned seq: undo_pruned');
reset role;

-- ===== X5: after every kind of steps 1-3, the reverts and the prune =========
do $$
declare
  t text;
  n bigint;
  v_bad text := '';
begin
  for t in select c.table_name from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'store_id'
              and c.table_name in (select tablename from pg_tables where schemaname = 'public')
              and c.table_name <> 'audit_log' loop
    execute format('select count(*) from public.%I where store_id is null', t) into n;
    if n > 0 then v_bad := v_bad || t || ' '; end if;
  end loop;
  select count(*) into n from public.audit_log where via_register and store_id is null;
  if n > 0 then v_bad := v_bad || 'audit_log(via_register) '; end if;
  insert into _r values ('x5', to_jsonb(v_bad));
end $$;
select is((select j #>> '{}' from _r where k = 'x5'), '',
  'X5 no NULL-store row anywhere (register_undo and register_ops_foreign included) after every kind of steps 1-3');
select ok(not exists (select 1 from public.audit_log where via_register and actor in (u('71'), u('72'), u('73'), v3('74')))
          and (select bool_and(exists (select 1 from public.users x where x.id = a.actor and x.store_id = a.store_id))
                 from public.audit_log a where a.via_register)
          and (select count(*) from public.register_bypass) = 0
          and coalesce(current_setting('lensy.register_admin', true), '') = ''
          and coalesce(current_setting('lensy.money_write', true), '') = '',
  'X6 no audit row attributed to a register login; every token closed, lensy.register_admin and lensy.money_write empty after the reverts');

select * from finish();
rollback;
