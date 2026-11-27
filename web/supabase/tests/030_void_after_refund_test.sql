-- ============================================================
-- !! DO NOT PASTE THIS INTO YOUR LIVE DATABASE. !!
-- This is a TEST, not a migration. It runs inside `begin; ... rollback;`.
-- ============================================================
-- 030 gate (H4): void_sale refunds the NET left on each tender. Before 030 it
-- mirrored every original payment row and ignored refund_sale's rows, so the
-- ledger summed below zero, sales_amount_paid_nonneg fired, and a sale that had
-- ever been partly refunded could never be voided.
begin;
create extension if not exists pgtap;
select plan(7);

insert into public.stores (id, name, time_zone)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'v shop', 'Africa/Cairo') on conflict (id) do nothing;
insert into public.store_licenses (store_id, license_key, plan, expires_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'STORE-V', 'pro', null) on conflict (store_id) do nothing;
insert into auth.users (id, email, username)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', 'vboss@lensypos.local', 'vboss') on conflict (id) do nothing;
insert into public.roles (id, name, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1', 'v manager', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301') on conflict (id) do nothing;
insert into public.permissions (code, name) values ('history.void', 'Void a sale') on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1'::uuid, p.id
  from public.permissions p where p.code in ('history.view', 'history.void')
on conflict do nothing;
insert into public.users (id, username, password_hash, store_id, role_id, is_active)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', 'vboss', '-', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301',
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000003b1', true) on conflict (id) do nothing;
insert into public.customers (id, name, store_id)
values ('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a3', 'v customer', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301') on conflict (id) do nothing;
select public.seed_refund_permission();

create function _imp(p_uid uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text)::text, false);
end $$;
create function _refund(p_id uuid, p_amt numeric, p_method text) returns void
language plpgsql security definer set search_path = public as $$
begin perform public.refund_sale(p_id, p_amt, p_method, 'overcharge'); end $$;
create function v_sale() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1'::uuid $$;

-- two cash rows on purpose: proves aggregation per method, not per row
insert into public.sales (id, store_id, invoice_no, kind, total_amount, discount, net_amount, amount_paid,
                          payment_method, user_id, customer_id)
values (v_sale(), 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'V0001', 'sale', 700, 0, 700, 700, 'cash',
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a3');
insert into public.sale_payments (sale_id, amount, method, kind, store_id, recorded_by) values
  (v_sale(), 200, 'cash',   'payment', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1'),
  (v_sale(), 100, 'cash',   'payment', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1'),
  (v_sale(), 400, 'wallet', 'payment', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000301', 'aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1');

set role authenticated;
select _imp('aaaaaaaa-aaaa-4aaa-8aaa-0000000003a1'::uuid);
select _refund(v_sale(), 100, 'cash');

select is((select amount_paid from public.sales where id = v_sale()), 600::numeric,
  'G-V1 partial refund leaves 600 paid');
select lives_ok($$ select public.void_sale('aaaaaaaa-aaaa-4aaa-8aaa-0000000003c1'::uuid, 'returned', true) $$,
  'G-V2 a sale with a prior partial refund can still be voided (before 030: 23514 sales_amount_paid_nonneg)');
select ok((select voided_at is not null from public.sales where id = v_sale()),
  'G-V3 the sale is voided');
select is((select amount_paid from public.sales where id = v_sale()), 0::numeric,
  'G-V4 amount_paid ends at exactly 0 - no over-refund');
select is((select coalesce(sum(amount), 0) from public.sale_payments where sale_id = v_sale() and method = 'cash'),
  0::numeric, 'G-V5 cash nets to 0: void refunded only the 200 cash that remained');
select is((select coalesce(sum(amount), 0) from public.sale_payments where sale_id = v_sale() and method = 'wallet'),
  0::numeric, 'G-V6 wallet nets to 0');
select is((select amount from public.sale_payments
            where sale_id = v_sale() and kind = 'refund' and method = 'cash' and note like 'Void%'),
  -200::numeric, 'G-V7 one void refund row on cash for the net remaining 200');

select * from finish();
rollback;
