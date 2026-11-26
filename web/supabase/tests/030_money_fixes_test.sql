-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (H8 + per-store invoice numbers + cross-store replay).
--
-- H8: a checkout whose first attempt committed but whose response was lost is
-- replayed with the same idempotency key. If the cashier was deactivated or the
-- licence lapsed in between, the replay must still return the ORIGINAL sale -
-- it acknowledges a fact that already happened - while a NEW key is refused.
--
-- INV: invoice numbers are counted per store (012), so they must be unique per
-- store too. Before 030 a second store drew 000001 from its own counter and hit
-- the GLOBAL sales_invoice_no_key, so it could not check out at all.
begin;
create extension if not exists pgtap;
select plan(11);

create function s_a() returns uuid language sql stable as $$ select id from public.stores order by created_at limit 1 $$;
insert into public.stores (id, name) values ('30000000-0000-4000-8000-0000000000b0', 'Store B30') on conflict (id) do nothing;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values ('30000000-0000-4000-8000-0000000000b0', 'STORE-B30', 'pro', null) on conflict (store_id) do nothing;
insert into public.roles (id, name, store_id) values
  ('30000000-0000-4000-8000-0000000000a1', 'Seller30', s_a()),
  ('30000000-0000-4000-8000-0000000000b1', 'Seller30', '30000000-0000-4000-8000-0000000000b0');
insert into public.role_permissions (role_id, permission_id)
select r, p.id
  from unnest(array['30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000b1']::uuid[]) r
 cross join public.permissions p where p.code in ('pos.view', 'pos.create');
insert into auth.users (id, email) values
  ('30000000-0000-4000-8000-0000000000a2', 'a30@t'),
  ('30000000-0000-4000-8000-0000000000b2', 'b30@t');
insert into public.users (id, username, password_hash, store_id, role_id, is_active) values
  ('30000000-0000-4000-8000-0000000000a2', 'cash_a30', '-', s_a(), '30000000-0000-4000-8000-0000000000a1', true),
  ('30000000-0000-4000-8000-0000000000b2', 'cash_b30', '-', '30000000-0000-4000-8000-0000000000b0', '30000000-0000-4000-8000-0000000000b1', true);

create table _c (k text primary key, sale_id uuid, inv text, err text);
grant all on _c to authenticated;
create function _co(p_k text, p_key uuid) returns void language plpgsql as $$
declare s public.sales;
begin
  s := public.create_sale_order('{"total_amount":0,"discount":0,"net_amount":0,"amount_paid":0}'::jsonb, '[]'::jsonb,
       '[{"exam_type":"distance"}]'::jsonb, '[]'::jsonb, p_key);
  insert into _c values (p_k, s.id, s.invoice_no, null);
exception when others then
  insert into _c (k, err) values (p_k, sqlerrm);
end $$;
create function _as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p)::text, true);
end $$;

-- H8: replay after the cashier is deactivated / the licence lapses returns the SAME sale
set role authenticated; select _as('30000000-0000-4000-8000-0000000000a2');
select _co('h8_first', '30000000-0000-4000-8000-00000000c0de');
reset role;
update public.users set is_active = false where id = '30000000-0000-4000-8000-0000000000a2';
set role authenticated; select _as('30000000-0000-4000-8000-0000000000a2');
select _co('h8_replay_inactive', '30000000-0000-4000-8000-00000000c0de');
reset role;
update public.users set is_active = true where id = '30000000-0000-4000-8000-0000000000a2';
update public.store_licenses set is_revoked = true where store_id = s_a();
set role authenticated; select _as('30000000-0000-4000-8000-0000000000a2');
select _co('h8_replay_unlicensed', '30000000-0000-4000-8000-00000000c0de');
select _co('h8_new_unlicensed', '30000000-0000-4000-8000-00000000beef');
reset role;
update public.store_licenses set is_revoked = false where store_id = s_a();

select is((select err from _c where k = 'h8_replay_inactive'), null,
  'H8 replay by a since-deactivated cashier does not error');
select is((select sale_id from _c where k = 'h8_replay_inactive'), (select sale_id from _c where k = 'h8_first'),
  'H8 ... and returns the original sale');
select is((select sale_id from _c where k = 'h8_replay_unlicensed'), (select sale_id from _c where k = 'h8_first'),
  'H8 replay after licence revocation returns the original sale');
select isnt((select err from _c where k = 'h8_new_unlicensed'), null,
  'H8 a NEW key is still refused without a licence');
select is((select count(*) from public.sales where idempotency_key = '30000000-0000-4000-8000-00000000c0de'), 1::bigint,
  'H8 exactly one sale for the key');

-- Invoice numbers are per store: store B's counter reuses A's numbers without colliding
set role authenticated; select _as('30000000-0000-4000-8000-0000000000a2');
select _co('inv_a1', null);
select _co('inv_a2', null);
reset role;
-- Pin the collision: store A holds 000001 (its counter may have started
-- elsewhere), so store B drawing 000001 below is a number BOTH stores hold.
insert into public.sales (store_id, invoice_no, total_amount, net_amount, amount_paid, lab_status)
values (s_a(), '000001', 0, 0, 0, null)
on conflict (store_id, invoice_no) do nothing;
set role authenticated;
select _as('30000000-0000-4000-8000-0000000000b2');
select _co('inv_b1', null);
reset role;
select is((select err from _c where k = 'inv_b1'), null,
  'INV second store can check out while store A holds the same numbers');
select is((select inv from _c where k = 'inv_b1'), '000001',
  'INV store B starts its own sequence at 000001');
select ok(exists(select 1 from public.sales
                  where store_id = s_a() and invoice_no = (select inv from _c where k = 'inv_b1')),
  'INV ... a number store A holds too');
select throws_ok($$ insert into public.sales (store_id, invoice_no, total_amount, net_amount, amount_paid)
                    select store_id, invoice_no, 0, 0, 0 from public.sales
                     where id = (select sale_id from _c where k = 'inv_a1') $$,
  '23505', null, 'INV invoice_no is still unique within a store');

-- XSTORE: an idempotency key names a sale only within the caller's store. Store
-- B's cashier sending store A's key (a collision, or a guessed key) must not be
-- handed store A's sale; it is a NEW key for store B.
set role authenticated; select _as('30000000-0000-4000-8000-0000000000b2');
select _co('xstore_replay', '30000000-0000-4000-8000-00000000c0de');
reset role;
select isnt((select sale_id from _c where k = 'xstore_replay'), (select sale_id from _c where k = 'h8_first'),
  'XSTORE store B replaying store A''s key does not get store A''s sale');
select is((select s.store_id from public.sales s where s.id = (select sale_id from _c where k = 'xstore_replay')),
  '30000000-0000-4000-8000-0000000000b0'::uuid, 'XSTORE ... it gets a sale of its own store');

select * from finish();
rollback;
