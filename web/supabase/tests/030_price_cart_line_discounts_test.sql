-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (H3): price_cart keeps the client's net when line discounts are
-- present. Before 030 every line discount was added back onto what the
-- customer owed (2 x 500 with a 100 line discount and a net of 900 was stored
-- as 1000 / 0 / 1000), so a re-checkout left a phantom balance.
-- P4/P5 pin the no-line-discount behaviour (012 T4/T5), which is unchanged.
begin;
create extension if not exists pgtap;
select plan(9);

create function test_store_id() returns uuid
language sql stable as $$ select id from public.stores order by created_at limit 1 $$;

insert into auth.users (id, email, username)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier@lensypos.local', 'cashier');
insert into public.roles (id, name, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000030b1', 'gate_030_price', test_store_id());
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000030b1', p.id
  from public.permissions p where p.code = any(public.supported_permissions())
on conflict do nothing;
insert into public.users (id, username, password_hash, full_name, store_id, role_id, is_active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'cashier', '-', 'Cashier', test_store_id(),
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000030b1', true);

insert into public.inventory (id, name, category, sale_price, cost_price, store_id)
values
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 'Test Lens A', 'Lens',  500.00, 200.00, test_store_id()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000002', 'Test Frame B', 'Frame', 100.00,  40.00, test_store_id());
insert into public.stock_movements (product_id, qty, type, note, store_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 10, 'initial', 'seed', test_store_id());

create table _cap (k text primary key, sale_id uuid, note text, err text);
grant all on _cap to authenticated;

create function _checkout(p_k text, p_sale jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  v_id := (public.create_sale_order(p_sale, p_items, '[]'::jsonb, p_payments, null)).id;
  insert into _cap (k, sale_id) values (p_k, v_id);
exception when others then
  insert into _cap (k, err) values (p_k, sqlerrm);
end $$;

create function _update(p_k text, p_sale_id uuid, p_sale jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns void language plpgsql as $$
begin
  perform public.update_sale_order(p_sale_id, p_sale, p_items, '[]'::jsonb, p_payments);
  insert into _cap (k, sale_id, note) values (p_k, p_sale_id, 'ok');
exception when others then
  insert into _cap (k, sale_id, err) values (p_k, p_sale_id, sqlerrm);
end $$;

-- direct pricing core (runs as superuser before impersonation, so no RLS)
create function _pc(p_items jsonb, p_net numeric) returns text language sql as $$
  select to_char(t.total_amount, 'FM999990.00') || '|' || to_char(t.discount, 'FM999990.00') || '|' || to_char(t.net_amount, 'FM999990.00')
    from public.price_cart(p_items, p_net, true) t $$;

select is(_pc('[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A","discount":100}]', 900),
  '1000.00|100.00|900.00', 'P1 a line discount alone: client net 900 is kept, discount includes the line discount');
select is(_pc('[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A","discount":100}]', 800),
  '1000.00|200.00|800.00', 'P2 line + header discount: net 800, discount 200');
select is(_pc('[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A","discount":100}]', 950),
  '1000.00|50.00|950.00', 'P3 net between line-net and gross keeps the catalog gross');
select is(_pc('[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A"}]', 1200),
  '1200.00|0.00|1200.00', 'P4 no line discounts: a price above catalog is unchanged (012 T5)');
select is(_pc('[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A"}]', 800),
  '1000.00|200.00|800.00', 'P5 no line discounts: 012 T4 unchanged');

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', false);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001"}', false);

select _checkout('L1', '{"net_amount":900,"amount_paid":900,"payment_method":"Cash"}'::jsonb,
  '[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A","discount":100,"discount_reason":"loyal"}]'::jsonb,
  '[{"method":"cash","amount":900}]'::jsonb);
select is((select total_amount || '|' || discount || '|' || net_amount || '|' || amount_paid
             from public.sales where id = (select sale_id from _cap where k = 'L1')),
  '1000.00|100.00|900.00|900.00', 'L1 checkout with a line discount stores net = what the customer was charged');
select is((select discount || '|' || discount_reason from public.sale_items
            where sale_id = (select sale_id from _cap where k = 'L1')),
  '100.00|loyal', 'L1b the line discount and its reason are stored on the item');

select _update('L2', (select sale_id from _cap where k = 'L1'),
  '{"net_amount":900,"amount_paid":900,"payment_method":"Cash"}'::jsonb,
  '[{"product_id":"bbbbbbbb-bbbb-4bbb-8bbb-000000000001","qty":2,"unit_price":500,"total_price":1000,"name":"Test Lens A","discount":100,"discount_reason":"loyal"}]'::jsonb,
  '[{"method":"cash","amount":900}]'::jsonb);
select is((select err from _cap where k = 'L2'), null, 'L2a re-checkout with the same line discount succeeds');
select is((select net_amount - amount_paid from public.sales where id = (select sale_id from _cap where k = 'L1')),
  0::numeric, 'L2 re-checkout with the same line discount leaves no phantom balance');

select * from finish();
rollback;
