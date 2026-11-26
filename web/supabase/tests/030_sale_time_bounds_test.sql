-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (client clock): create_sale_order keeps a client order_date /
-- paid_at (a checkout replayed from the offline queue keeps the time Finish was
-- pressed) only inside [latest closed shift's to_at, and at most 2 days back,
-- now()]. A slow device clock or a late replay must not put money into a shift
-- whose expected cash is already frozen, a fast one must not date a sale in the
-- future, and a 2020 clock must not reach back years.
--
-- now() is the transaction's start time, so every bound below is exact.
begin;
create extension if not exists pgtap;
select plan(11);

insert into public.stores (id, name, time_zone)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000501', 'clock shop', 'Africa/Cairo')
on conflict (id) do nothing;
create function k_store() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000501'::uuid $$;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values (k_store(), 'STORE-K1', 'pro', null) on conflict (store_id) do nothing;
insert into auth.users (id, email) values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000005a1', 'k1@t') on conflict do nothing;
insert into public.roles (id, name, store_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000005b1', 'k1 cashier', k_store());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000005b1', p.id from public.permissions p where p.code in ('pos.view', 'pos.create');
insert into public.users (id, username, password_hash, store_id, role_id, is_active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000005a1', 'k1cash', '-', k_store(), 'aaaaaaaa-aaaa-4aaa-8aaa-0000000005b1', true);
insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000005d1', 'K Frame', 'Frame', 100, 40, k_store());

create table _k (k text primary key, sale_id uuid, err text);
grant all on _k to authenticated;
-- One 100 cash checkout claiming the client time p_at (null = no time sent).
create function _co(p_k text, p_at timestamptz) returns void language plpgsql as $$
declare s public.sales;
begin
  s := public.create_sale_order(
    jsonb_strip_nulls(jsonb_build_object('total_amount', 100, 'discount', 0, 'net_amount', 100,
                                         'amount_paid', 100, 'order_date', p_at)),
    '[{"product_id":"aaaaaaaa-aaaa-4aaa-8aaa-0000000005d1","qty":1,"unit_price":100,"total_price":100,"name":"K Frame"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('method', 'cash', 'amount', 100, 'paid_at', p_at))),
    gen_random_uuid());
  insert into _k values (p_k, s.id, null);
exception when others then
  insert into _k (k, err) values (p_k, sqlerrm);
end $$;
create function _paid(p_k text) returns timestamptz language sql as $$
  select max(paid_at) from public.sale_payments where sale_id = (select sale_id from _k where k = p_k) $$;
create function _ordered(p_k text) returns timestamptz language sql as $$
  select order_date from public.sales where id = (select sale_id from _k where k = p_k) $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000005a1', false);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-0000000005a1"}', false);

-- No shift closed yet.
select _co('replay', now() - interval '3 hours');
select is(_paid('replay'), now() - interval '3 hours', 'K1 a plausible client time (queued replay) is kept for the payment');
select is(_ordered('replay'), now() - interval '3 hours', 'K1b ... and for the sale');
select _co('fast', now() + interval '1 day');
select is(_paid('fast'), now(), 'K2 a clock in the future is brought back to now()');
select _co('ancient', '2020-01-01 00:00+00');
select is(_paid('ancient'), now() - interval '2 days', 'K3 a 2020 clock reaches back at most 2 days (payment)');
select is(_ordered('ancient'), now() - interval '2 days', 'K3b ... and the sale');
select _co('servertime', null);
select is(_paid('servertime'), now(), 'K4 no client time means the server''s now()');

-- The shift up to 30 minutes ago is closed (close_shift writes this row; it is
-- inserted directly here so the window is exact).
reset role;
insert into public.shift_closes (store_id, from_at, to_at, counted_cash, expected_cash, expected_total, variance)
values (k_store(), now() - interval '10 hours', now() - interval '30 minutes', 100, 100, 100, 0);
set role authenticated;

select _co('slow', now() - interval '1 hour');
select is(_paid('slow'), now() - interval '30 minutes',
  'K5 a time inside the closed shift is moved to its end: the money belongs to the open shift');
select is(_ordered('slow'), now() - interval '30 minutes', 'K5b ... and so does the sale');
select is((select count(*)::int from public.sale_payments
            where store_id = k_store() and paid_at >= now() - interval '10 hours' and paid_at < now() - interval '30 minutes'),
  1, 'K6 the closed window still holds only the payment it was closed with (the 3-hour-old replay)');
select _co('after', now() - interval '10 minutes');
select is(_paid('after'), now() - interval '10 minutes', 'K7 a time after the close is kept');
select is((select count(*)::int from _k where err is not null), 0, 'K8 no checkout was refused for its clock');

select * from finish();
rollback;
